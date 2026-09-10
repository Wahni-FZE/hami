# Copyright (c) 2026, Wahni IT Solutions UAE and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class HamiSettings(Document):
	pass


@frappe.whitelist()
def get_override_pos_print_receipt():
	# Whitelisted so POS cashiers (no read access to Hami Settings) can check it.
	# get_single applies the field default, so it matches what the form shows.
	return frappe.get_single("Hami Settings").override_pos_print_receipt
