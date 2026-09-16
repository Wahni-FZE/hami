// ============================================================
// HAMI PERFUMES - Thermal Receipt (Raw ESC/POS via QZ Tray)
//
// Loaded by hooks.py :: page_js on the Point of Sale page only.
// Replaces the "Print Receipt" button on the POS order summary with a
// "Thermal Print" button that sends a raw ESC/POS receipt to the till printer.
//
// ERPNext's own print_receipt method is not overridden - it just loses its
// button, so nothing else in POS changes.
// ============================================================

var RCPT = {
	W: 42,
	// printer per POS Profile - add a line for each branch
	PRINTERS: {
		"Sharjah Branch POS": "POS80 Printer",
		"Satwa (Main) Branch POS": "POS-80",
	},
	PRINTER_DEFAULT: "POS80 Printer",
	ENCODING: "windows-1252", // needed for the (R) glyph
	ESC: "\x1B",
	GS: "\x1D",
	FS: "\x1C",

	TM: "\xAE", // (R) - set to '(R)' if it prints wrong
	COMPANY: "Zulfiqar Hami Trading (L.L.C.)",
	TAGLINE: "www.hamiperfumes.com",

	// used only if POS Profile has no company address
	TEL_FALLBACK: "Tel No:04 2266284",
	ADDR_FALLBACK: ["Dubai-Dubai,U.A.E."],

	TRN: "100039269400003",
	FOOTER1: "Quality Means The World To Us",
	FOOTER2: "Please Visit Again.   Thank You.",

	VAT_RATE: 5,
	USE_NVRAM_LOGO: false,

	// widths: 2+1+13+1+5+1+6+1+3+1+8 = 42
	C_SRL: 2,
	C_PROD: 13,
	C_QTY: 5,
	C_RATE: 6,
	C_VAT: 3,
	C_AMT: 8,
};

var RC_ADDR_CACHE = RC_ADDR_CACHE || {};

// ---------- text helpers ----------

function rc_line(ch) {
	return (ch || "-").repeat(RCPT.W) + "\n";
}

function rc_center(t) {
	t = String(t == null ? "" : t);
	if (t.length >= RCPT.W) return t.substring(0, RCPT.W) + "\n";
	return " ".repeat(Math.floor((RCPT.W - t.length) / 2)) + t + "\n";
}

function rc_lr(l, r) {
	l = String(l == null ? "" : l);
	r = String(r == null ? "" : r);
	const gap = RCPT.W - l.length - r.length;
	if (gap < 1) return l.substring(0, Math.max(0, RCPT.W - r.length - 1)) + " " + r + "\n";
	return l + " ".repeat(gap) + r + "\n";
}

function rc_padL(t, w) {
	t = String(t == null ? "" : t);
	return t.length >= w ? t.substring(t.length - w) : " ".repeat(w - t.length) + t;
}

function rc_padR(t, w) {
	t = String(t == null ? "" : t);
	return t.length >= w ? t.substring(0, w) : t + " ".repeat(w - t.length);
}

function rc_num(v, dp) {
	return format_number(flt(v), null, dp === undefined ? 2 : dp);
}

function rc_time(t) {
	const parts = String(t || "").split(".")[0].split(":");
	if (parts.length < 2) return String(t || "");
	return parts
		.slice(0, 3)
		.map(function (p) {
			return p.length < 2 ? "0" + p : p;
		})
		.join(":");
}

function rc_salesperson(doc) {
	const uid = doc.owner || frappe.session.user;
	let nm = "";
	try {
		const info = frappe.user_info(uid);
		if (info && info.fullname) nm = info.fullname;
	} catch (e) {
		nm = "";
	}
	if (!nm || nm === uid) nm = String(uid).split("@")[0];
	return nm;
}

function rc_factor(doc) {
	const t = flt(doc.total);
	const g = flt(doc.grand_total);
	if (!t || !g) return 1;
	const f = g / t;
	return f > 0.9 && f < 1.5 ? f : 1;
}

function rc_wrap(txt, w) {
	const words = String(txt || "").split(/\s+/);
	const out = [];
	let cur = "";
	words.forEach(function (word) {
		while (word.length > w) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
			out.push(word.substring(0, w));
			word = word.substring(w);
		}
		if (!cur) {
			cur = word;
		} else if ((cur + " " + word).length <= w) {
			cur += " " + word;
		} else {
			out.push(cur);
			cur = word;
		}
	});
	if (cur) out.push(cur);
	return out.length ? out : [""];
}

function rc_item_row(srl, name, qty, rate, vat, amt) {
	const names = rc_wrap(name, RCPT.C_PROD);
	let out = "";
	names.forEach(function (nm, idx) {
		if (idx === 0) {
			out +=
				rc_padL(srl, RCPT.C_SRL) +
				" " +
				rc_padR(nm, RCPT.C_PROD) +
				" " +
				rc_padL(qty, RCPT.C_QTY) +
				" " +
				rc_padL(rate, RCPT.C_RATE) +
				" " +
				rc_padR(vat, RCPT.C_VAT) +
				" " +
				rc_padL(amt, RCPT.C_AMT) +
				"\n";
		} else {
			out += " ".repeat(RCPT.C_SRL + 1) + nm + "\n";
		}
	});
	return out;
}

// ---------- branch address from POS Profile ----------

function rc_default_address() {
	return { lines: RCPT.ADDR_FALLBACK.slice(), phone: RCPT.TEL_FALLBACK };
}

function rc_fetch_address(doc) {
	const key = doc.pos_profile || "__default__";
	if (RC_ADDR_CACHE[key]) return Promise.resolve(RC_ADDR_CACHE[key]);

	return new Promise(function (resolve) {
		const done = function (res) {
			RC_ADDR_CACHE[key] = res;
			resolve(res);
		};

		if (!doc.pos_profile) return done(rc_default_address());

		frappe.db
			.get_value("POS Profile", doc.pos_profile, "company_address")
			.then(function (r) {
				const addr = r && r.message && r.message.company_address;
				if (!addr) return done(rc_default_address());

				return frappe.db
					.get_value("Address", addr, [
						"address_line1",
						"address_line2",
						"city",
						"country",
						"phone",
					])
					.then(function (a) {
						const v = (a && a.message) || {};
						const lines = [];
						if (v.address_line1) lines.push(v.address_line1);
						if (v.address_line2) lines.push(v.address_line2);
						const loc = [v.city, v.country].filter(Boolean).join(",");
						if (loc) lines.push(loc);
						done({
							lines: lines.length ? lines : RCPT.ADDR_FALLBACK.slice(),
							phone: v.phone ? "Tel No:" + v.phone : RCPT.TEL_FALLBACK,
						});
					});
			})
			.catch(function () {
				done(rc_default_address());
			});
	});
}

// ---------- receipt body ----------

function rc_build(doc, addr) {
	const E = RCPT.ESC,
		G = RCPT.GS,
		F = RCPT.FS;
	addr = addr || rc_default_address();
	let d = "";

	d += E + "@";
	d += E + "t" + "\x10"; // codepage 16 = WPC1252

	// ---- header ----
	d += E + "a" + "\x01"; // center

	if (RCPT.USE_NVRAM_LOGO) {
		d += F + "p" + "\x01" + "\x00";
		d += "\n";
	} else {
		d += E + "E" + "\x01"; // emphasis on
		d += G + "!" + "\x22"; // 3x wide, 3x tall
		d += "HAMI" + RCPT.TM + "\n";
		d += G + "!" + "\x11"; // 2x wide, 2x tall
		d += "PERFUMES\n";
		d += G + "!" + "\x00"; // normal size
		d += E + "E" + "\x00"; // emphasis off
	}

	d += RCPT.TAGLINE + "\n";
	d += E + "!" + "\x08";
	d += RCPT.COMPANY + "\n";
	d += E + "!" + "\x00";
	d += addr.phone + "\n";
	addr.lines.forEach(function (l) {
		d += l + "\n";
	});
	d += "\n";

	d += E + "!" + "\x18";
	d += E + "-" + "\x01";
	d += "TRN:" + RCPT.TRN + "\n";
	d += E + "-" + "\x00";
	d += "Tax Invoice\n";
	d += E + "!" + "\x00";

	// ---- meta ----
	d += E + "a" + "\x00";
	d += rc_line("-");
	d += "Inv#" + (doc.name || "DRAFT") + "\n";
	d += rc_lr(rc_time(doc.posting_time), frappe.datetime.str_to_user(doc.posting_date || ""));
	d += "SalesPerson:" + rc_salesperson(doc) + "\n";
	d += rc_line("-");
	d +=
		E +
		"!" +
		"\x08" +
		"Customer: " +
		E +
		"!" +
		"\x00" +
		(doc.customer_name || doc.customer || "Walk In Customer") +
		"\n";
	d += "Customer TRN " + (doc.tax_id || "") + "\n";

	// ---- column headings ----
	d += rc_line("-");
	d +=
		rc_padL("Sr", RCPT.C_SRL) +
		" " +
		rc_padR("Product", RCPT.C_PROD) +
		" " +
		rc_padL("Qty", RCPT.C_QTY) +
		" " +
		rc_padL("Rate", RCPT.C_RATE) +
		" " +
		rc_padR("VAT", RCPT.C_VAT) +
		" " +
		rc_padL("Amount", RCPT.C_AMT) +
		"\n";
	d +=
		" ".repeat(RCPT.C_SRL + 1 + RCPT.C_PROD + 1 + RCPT.C_QTY + 1) +
		rc_padL("(AED)", RCPT.C_RATE) +
		" " +
		rc_padR(RCPT.VAT_RATE + "%", RCPT.C_VAT) +
		" " +
		rc_padL("Incl Tax", RCPT.C_AMT) +
		"\n";
	d += rc_line("-");

	// ---- items ----
	let totalQty = 0;
	const factor = rc_factor(doc);

	(doc.items || []).forEach(function (i, n) {
		totalQty += flt(i.qty);
		d += rc_item_row(
			n + 1,
			i.item_name || i.item_code,
			rc_num(i.qty, 3),
			rc_num(i.rate),
			RCPT.VAT_RATE + "%",
			rc_num(flt(i.amount) * factor)
		);
	});

	// ---- totals ----
	d += rc_line("-");
	d += E + "!" + "\x08";
	d += rc_lr("        SUB TOTAL", rc_num(doc.net_total) + "  ");
	d += rc_lr("        VAT " + RCPT.VAT_RATE + "%", rc_num(doc.total_taxes_and_charges) + "  ");
	d += rc_lr("      GRAND TOTAL", rc_num(doc.grand_total) + "  ");
	d += E + "!" + "\x00";
	d += rc_line("-");

	d += E + "a" + "\x01";
	d += E + "!" + "\x08";
	d += "Total Qty: " + rc_num(totalQty, 3) + "   Amt: " + rc_num(doc.grand_total) + "\n";
	d += E + "!" + "\x00";

	if (doc.in_words) {
		rc_wrap("(" + doc.in_words + ")", RCPT.W - 2).forEach(function (l) {
			d += rc_center(l);
		});
	}
	d += "\n";

	// ---- tender / return ----
	d += E + "a" + "\x00";
	let tender = flt(doc.paid_amount);
	if (!tender && doc.payments) {
		(doc.payments || []).forEach(function (p) {
			tender += flt(p.amount);
		});
	}
	d += rc_lr("  Tender:", rc_num(tender) + "  ");
	d += rc_lr("  Return:", rc_num(doc.change_amount) + "  ");

	// ---- footer ----
	d += rc_line("=");
	d += E + "a" + "\x01";
	d += E + "!" + "\x08";
	d += RCPT.FOOTER1 + "\n";
	d += E + "!" + "\x00";
	d += RCPT.FOOTER2 + "\n";

	d += "\n\n\n";
	d += G + "V" + "\x42" + "\x00";
	return d;
}

// Resolve which printer to use.
// Priority: this machine's override > POS Profile map > default.
// To pin one till to a specific printer, run in the console:
//     localStorage.rc_printer = 'Exact Printer Name';
// To clear it:  delete localStorage.rc_printer;
function rc_printer(doc) {
	var over = null;
	try {
		over = localStorage.getItem("rc_printer");
	} catch (e) {
		over = null;
	}
	if (over) return over;
	var prof = doc && doc.pos_profile;
	if (prof && RCPT.PRINTERS[prof]) return RCPT.PRINTERS[prof];
	return RCPT.PRINTER_DEFAULT;
}

// ---------- QZ connection ----------
// qz-tray.js is not on the page by default - the only thing that loads it is
// frappe.ui.form.qz_init(), called by qz_connect() (frappe/public/js/frappe/form/
// print_utils.js). It also wires setPromiseType/setSha256Type and handles the
// launch prompt. It lives in form.bundle.js, which the POS page has because POS
// builds a real frappe.ui.form.Form; the fallback covers anywhere it is missing.

function rc_connect() {
	if (frappe.ui.form && frappe.ui.form.qz_connect) {
		return frappe.ui.form.qz_connect();
	}
	return frappe
		.require([
			"/assets/frappe/node_modules/js-sha256/build/sha256.min.js",
			"/assets/frappe/node_modules/qz-tray/qz-tray.js",
		])
		.then(function () {
			qz.api.setPromiseType(function (resolver) {
				return new Promise(resolver);
			});
			qz.api.setSha256Type(function (data) {
				return sha256(data);
			});
			if (qz.websocket.isActive()) return;
			return qz.websocket.connect();
		});
}

function rc_print(doc) {
	Promise.all([rc_connect(), rc_fetch_address(doc)])
		.then(function (res) {
			const name = rc_printer(doc);
			const cfg = qz.configs.create(name, { encoding: RCPT.ENCODING });
			return qz.print(cfg, [{ type: "raw", format: "plain", data: rc_build(doc, res[1]) }]);
		})
		.then(function () {
			frappe.show_alert({ message: "Sent to " + rc_printer(doc), indicator: "green" });
		})
		.catch(function (e) {
			console.error("QZ error:", e);
			frappe.msgprint({ title: "Print Failed", message: String(e), indicator: "red" });
		});
}

// ---------- diagnostics (call from the browser console) ----------

function rc_strip(s) {
	return s
		.replace(/\x1B@/g, "")
		.replace(/\x1B[!ta\-E]./g, "")
		.replace(/\x1D!./g, "")
		.replace(/\x1DV../g, "")
		.replace(/\x1Cp../g, "");
}

function rc_list_printers() {
	rc_connect()
		.then(function () {
			return qz.printers.find();
		})
		.then(function (list) {
			frappe.msgprint({
				title: "Printers QZ Can See",
				message: "<pre>" + list.join("\n") + "</pre>",
			});
		})
		.catch(function (e) {
			frappe.msgprint(String(e));
		});
}

function rc_preview(doc) {
	rc_fetch_address(doc).then(function (addr) {
		frappe.msgprint({
			title: "Receipt Preview (raw text)",
			message:
				'<pre style="font-family:monospace;font-size:12px;line-height:1.3;">' +
				frappe.utils.escape_html(rc_strip(rc_build(doc, addr))) +
				"</pre>",
		});
	});
}

// rc_list_printers() / rc_preview(cur_pos.order_summary.doc) from the console
window.rc_list_printers = rc_list_printers;
window.rc_preview = rc_preview;
window.rc_print = rc_print;

// ---------- POS screen integration ----------

function rc_patch_pos() {
	if (!window.erpnext || !erpnext.PointOfSale) return false;

	var S = erpnext.PointOfSale.PastOrderSummary;
	if (!S || !S.prototype) return false;
	if (S.prototype.__rc_patched) return true;
	S.prototype.__rc_patched = true;

	// Replace the "Print Receipt" button with "Thermal Print".
	// add_summary_btns builds each button from its label and takes the CSS class
	// from the first word, so this renders .thermal-btn and no .print-btn at all.
	// The stock print_receipt method is left intact - it simply has no button, so
	// the Ctrl+P shortcut finds no .print-btn and quietly does nothing.
	// get_condition_btn_map runs on every load_summary_of, so patching the
	// prototype is enough even if the summary instance already exists.
	var orig_map = S.prototype.get_condition_btn_map;
	if (orig_map) {
		S.prototype.get_condition_btn_map = function (after_submission) {
			var map = orig_map.call(this, after_submission) || [];
			map.forEach(function (m) {
				var btns = m.visible_btns || [];
				var i = btns.indexOf("Print Receipt");
				if (i === -1) return;
				if (btns.indexOf("Thermal Print") === -1) {
					btns.splice(i, 1, "Thermal Print");
				} else {
					btns.splice(i, 1);
				}
			});
			return map;
		};
	}

	return true;
}

// Delegated on document rather than bound in bind_events: by the time this script
// patches the prototype the summary instance may already be built, so its
// bind_events has run. .thermal-btn is our own class, so nothing else handles it.
if (!window.__rc_thermal_bound) {
	window.__rc_thermal_bound = true;
	$(document).on("click", ".thermal-btn", function () {
		var pos = window.cur_pos;
		var doc = pos && pos.order_summary && pos.order_summary.doc;
		if (doc) {
			rc_print(doc);
		} else {
			frappe.show_alert({ message: __("No invoice selected"), indicator: "orange" });
		}
	});
}

// page_js is appended after point_of_sale.js, but the summary class exists only
// once the POS bundle has been evaluated. frappe.assets guards against a second
// eval, so requiring it again is safe and resolves whichever order wins.
if (!rc_patch_pos()) {
	frappe.require("point-of-sale.bundle.js", rc_patch_pos);
}
