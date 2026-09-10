// Route the POS "Print Receipt" button through QZ Tray.
//
// erpnext.PointOfSale.PastOrderSummary.print_receipt() calls frappe.utils.print(),
// which only knows how to open a /printview window - so a raw ESC/POS format like
// "HAMI Thermal" gets HTML-rendered and the control codes show up as text.
//
// Frappe's real raw-print path lives in frappe/printing/page/print/print.js
// (printit -> get_raw_commands -> qz.print) and is not reachable from the POS
// page, so it is reimplemented here against the same localStorage printer
// mapping the standard Printer Settings dialog writes.

frappe.provide("hami.pos");

hami.pos.PRINTER_MAP_KEY = "print_format_printer_map";
hami.pos.DOCTYPE = "POS Invoice";

// The qz helpers live in form.bundle.js, which the POS page may not have loaded.
hami.pos.qz_ready = function () {
	if (frappe.ui.form && frappe.ui.form.qz_connect) {
		return Promise.resolve();
	}
	return frappe.require("form.bundle.js");
};

hami.pos.get_printer_map = function () {
	try {
		return JSON.parse(localStorage[hami.pos.PRINTER_MAP_KEY]) || {};
	} catch (e) {
		return {};
	}
};

hami.pos.get_mapped_printer = function (print_format) {
	const map = hami.pos.get_printer_map();
	return (map[hami.pos.DOCTYPE] || []).filter((row) => row.print_format === print_format);
};

// raw_printing rides along in the doctype meta (frappe/desk/form/meta.py ::
// load_print_formats does a "select *"), so this needs no extra round trip and
// no Print Format read permission - cashier roles usually lack that.
hami.pos.is_raw_format = function (print_format) {
	const meta = frappe.get_meta(hami.pos.DOCTYPE);
	const formats = (meta && meta.__print_formats) || [];
	const fmt = formats.find((f) => f.name === print_format);
	return fmt ? cint(fmt.raw_printing) : 0;
};

// Same shape as PrintView.printer_setting_dialog, scoped to POS Invoice so the
// mapping is shared with the standard print view.
hami.pos.printer_setting_dialog = function (print_format, on_save) {
	hami.pos.qz_ready().then(() => {
		frappe.ui.form.qz_get_printer_list().then((printer_list) => {
			if (!(printer_list && printer_list.length)) {
				frappe.throw(__("No Printer is Available."));
			}

			const dialog = new frappe.ui.Dialog({
				title: __("Select Receipt Printer"),
				fields: [
					{
						fieldname: "printer",
						fieldtype: "Select",
						label: __("Printer"),
						options: printer_list,
						reqd: 1,
						default: printer_list[0],
					},
				],
				primary_action_label: __("Save"),
				primary_action: ({ printer }) => {
					const map = hami.pos.get_printer_map();
					const rows = (map[hami.pos.DOCTYPE] || []).filter(
						(row) => row.print_format !== print_format
					);
					rows.push({ print_format: print_format, printer: printer });
					map[hami.pos.DOCTYPE] = rows;
					localStorage[hami.pos.PRINTER_MAP_KEY] = JSON.stringify(map);
					dialog.hide();
					on_save && on_save();
				},
			});
			dialog.show();
		});
	});
};

hami.pos.print_raw = function (doc, print_format) {
	const mapped = hami.pos.get_mapped_printer(print_format);

	if (mapped.length !== 1) {
		// No printer bound to this format on this machine yet - ask once, then print.
		hami.pos.printer_setting_dialog(print_format, () => hami.pos.print_raw(doc, print_format));
		return;
	}

	frappe.call({
		method: "frappe.www.printview.get_rendered_raw_commands",
		args: {
			doc: doc.doctype,
			name: doc.name,
			print_format: print_format,
		},
		callback: (r) => {
			if (r.exc || !r.message) return;

			hami.pos.qz_ready().then(() => {
				frappe.ui.form
					.qz_connect()
					.then(() => {
						const config = qz.configs.create(mapped[0].printer);
						return qz.print(config, [r.message.raw_commands]);
					})
					.then(frappe.ui.form.qz_success)
					.catch((err) => frappe.ui.form.qz_fail(err));
			});
		},
	});
};

hami.pos.patch_print_receipt = function () {
	const cls = erpnext.PointOfSale && erpnext.PointOfSale.PastOrderSummary;
	if (!cls || cls.prototype.__hami_thermal_patched) return;

	const browser_print = cls.prototype.print_receipt;

	cls.prototype.print_receipt = function () {
		const frm = this.events.get_frm();
		const print_format = frm && frm.pos_print_format;

		if (!print_format) {
			return browser_print.call(this);
		}

		if (!hami.pos.is_raw_format(print_format)) {
			return browser_print.call(this);
		}

		// Only take over when Hami Settings > Override POS print receipt is ticked.
		frappe
			.call("hami.hami.doctype.hami_settings.hami_settings.get_override_pos_print_receipt")
			.then((r) => {
				if (cint(r.message)) {
					hami.pos.print_raw(this.doc, print_format);
				} else {
					browser_print.call(this);
				}
			});
	};

	cls.prototype.__hami_thermal_patched = true;
};

// page_js is appended after point_of_sale.js, but the summary class only exists
// once the POS bundle has been evaluated. frappe.assets guards against a second
// eval, so requiring it again here is safe and resolves whichever order wins.
frappe.require("point-of-sale.bundle.js", hami.pos.patch_print_receipt);
