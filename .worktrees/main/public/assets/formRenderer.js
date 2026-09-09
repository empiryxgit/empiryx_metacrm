// Shared dynamic form renderer - THE single place a form's field list is
// turned into inputs, collected back into values, and validated
// client-side. Used by: the Form Builder's live preview
// (public/forms/builder.html), the public lead-capture page
// (public/form.html), and Pipeline's Add Customer / Not Interested -> Add
// to CRM modal (public/pipeline.html) whenever a company has a configured
// internal form. No build step - depends only on /assets/app.js (App.escapeHtml)
// being loaded first, same convention as every other page in this app.
//
// A "field" here is the shape returned by the Forms API - either a
// form_fields DB row or the safe public projection from
// GET /api/public/forms/{key}:
//   { key, label, fieldType, mappingType?, systemField?, options, placeholder,
//     helpText, defaultValue, required, conditional }

const FormRenderer = (() => {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^[0-9+\-\s().]{6,20}$/;

  function optionsFor(field, opts) {
    const dyn = opts.dynamicOptions || {};
    if (field.systemField && dyn[field.systemField]) return dyn[field.systemField];
    return (field.options || []).map((o) => ({ value: o, label: o }));
  }

  function inputTypeFor(fieldType) {
    if (fieldType === "email") return "email";
    if (fieldType === "phone") return "tel";
    if (fieldType === "number" || fieldType === "currency") return "number";
    if (fieldType === "date") return "date";
    if (fieldType === "datetime") return "datetime-local";
    return "text";
  }

  function renderInput(field, value, opts) {
    const val = value !== undefined && value !== null ? value : (field.defaultValue ?? "");
    const disabled = opts.disabledFields && opts.disabledFields.includes(field.key) ? "disabled" : "";
    const placeholder = field.placeholder ? `placeholder="${App.escapeHtml(field.placeholder)}"` : "";

    if (field.fieldType === "textarea") {
      return `<textarea data-field="${field.key}" rows="3" ${placeholder} ${disabled}>${App.escapeHtml(String(val))}</textarea>`;
    }

    if (field.fieldType === "select") {
      const choices = optionsFor(field, opts);
      return `<select data-field="${field.key}" ${disabled}>
        <option value="">Select…</option>
        ${choices.map((c) => `<option value="${App.escapeHtml(String(c.value))}" ${String(val) === String(c.value) ? "selected" : ""}>${App.escapeHtml(c.label)}</option>`).join("")}
      </select>`;
    }

    if (field.fieldType === "radio") {
      const choices = optionsFor(field, opts);
      return `<div class="radio-group">${choices
        .map(
          (c) =>
            `<label class="radio-option"><input type="radio" name="radio_${field.key}" data-field="${field.key}" value="${App.escapeHtml(String(c.value))}" ${String(val) === String(c.value) ? "checked" : ""} ${disabled}/> ${App.escapeHtml(c.label)}</label>`,
        )
        .join("")}</div>`;
    }

    if (field.fieldType === "multiselect") {
      const choices = optionsFor(field, opts);
      const selected = Array.isArray(val) ? val.map(String) : [];
      return `<div class="checkbox-group">${choices
        .map(
          (c) =>
            `<label class="checkbox-option"><input type="checkbox" data-field="${field.key}" value="${App.escapeHtml(String(c.value))}" ${selected.includes(String(c.value)) ? "checked" : ""} ${disabled}/> ${App.escapeHtml(c.label)}</label>`,
        )
        .join("")}</div>`;
    }

    if (field.fieldType === "checkbox") {
      return `<label class="checkbox-option"><input type="checkbox" data-field="${field.key}" ${val === true || val === "true" ? "checked" : ""} ${disabled}/> ${App.escapeHtml(field.helpText || "Yes")}</label>`;
    }

    // text | email | phone | number | currency | date | datetime
    return `<input type="${inputTypeFor(field.fieldType)}" data-field="${field.key}" value="${App.escapeHtml(String(val))}" ${field.fieldType === "number" || field.fieldType === "currency" ? 'step="any"' : ""} ${placeholder} ${disabled} />`;
  }

  function renderFieldWrapper(field, value, opts) {
    // Checkbox already carries its own inline label (a single yes/no
    // toggle reads best without a separate field label above it).
    const showLabel = field.fieldType !== "checkbox";
    const req = field.required ? '<span class="required-mark" title="Required">*</span>' : "";
    const help = field.helpText && field.fieldType !== "checkbox" ? `<div class="field-help">${App.escapeHtml(field.helpText)}</div>` : "";
    return `<div class="form-field" data-field-wrapper="${field.key}">
      ${showLabel ? `<label>${App.escapeHtml(field.label)}${req}</label>` : ""}
      ${renderInput(field, value, opts)}
      ${help}
      <div class="field-error" data-field-error="${field.key}"></div>
    </div>`;
  }

  /** fields: field[]; values: { [key]: value } | undefined; opts:
   * { dynamicOptions?: {[systemField]: {value,label}[]}, disabledFields?: string[] } */
  function renderFields(fields, values, opts) {
    opts = opts || {};
    values = values || {};
    return fields.map((f) => renderFieldWrapper(f, values[f.key], opts)).join("");
  }

  function collectValues(root, fields) {
    const values = {};
    fields.forEach((f) => {
      if (f.fieldType === "checkbox") {
        const el = root.querySelector(`[data-field="${f.key}"]`);
        values[f.key] = el ? el.checked : false;
      } else if (f.fieldType === "multiselect") {
        values[f.key] = Array.from(root.querySelectorAll(`[data-field="${f.key}"]:checked`)).map((el) => el.value);
      } else if (f.fieldType === "radio") {
        const checked = root.querySelector(`[data-field="${f.key}"]:checked`);
        values[f.key] = checked ? checked.value : "";
      } else {
        const el = root.querySelector(`[data-field="${f.key}"]`);
        values[f.key] = el ? el.value.trim() : "";
      }
    });
    return values;
  }

  /** Client-side mirror of src/domain/formValidation.ts - instant feedback
   * only. The server re-validates every submission from scratch and is the
   * only check that is ever trusted. */
  function validate(fields, values) {
    const errors = {};
    fields.forEach((f) => {
      const raw = values[f.key];
      const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0);
      if (f.required && empty && f.fieldType !== "checkbox") {
        errors[f.key] = `${f.label} is required.`;
        return;
      }
      if (empty) return;
      if (f.fieldType === "email" && (typeof raw !== "string" || !EMAIL_RE.test(raw.trim()))) {
        errors[f.key] = `${f.label} must be a valid email address.`;
      } else if (f.fieldType === "phone" && (typeof raw !== "string" || !PHONE_RE.test(raw.trim()))) {
        errors[f.key] = `${f.label} must be a valid phone number.`;
      } else if ((f.fieldType === "number" || f.fieldType === "currency") && !Number.isFinite(Number(raw))) {
        errors[f.key] = `${f.label} must be a number.`;
      } else if ((f.fieldType === "date" || f.fieldType === "datetime") && Number.isNaN(new Date(raw).getTime())) {
        errors[f.key] = `${f.label} must be a valid date.`;
      }
    });
    return errors;
  }

  function clearErrors(root) {
    root.querySelectorAll("[data-field-error]").forEach((el) => (el.textContent = ""));
    root.querySelectorAll(".form-field.has-error").forEach((el) => el.classList.remove("has-error"));
  }

  function showErrors(root, errors) {
    clearErrors(root);
    Object.entries(errors).forEach(([key, msg]) => {
      const el = root.querySelector(`[data-field-error="${key}"]`);
      if (el) el.textContent = msg;
      const wrapper = root.querySelector(`[data-field-wrapper="${key}"]`);
      if (wrapper) wrapper.classList.add("has-error");
    });
  }

  // ---- Conditional visibility (basic show/hide) ------------------------

  function currentFieldValue(root, key) {
    const group = root.querySelectorAll(`[data-field="${key}"]`);
    if (group.length === 0) return "";
    if (group.length === 1) {
      const el = group[0];
      return el.type === "checkbox" ? String(el.checked) : el.value;
    }
    // radio / multiselect / checkbox-group
    return Array.from(group)
      .filter((el) => el.checked)
      .map((el) => el.value)
      .join(",");
  }

  function evalConditional(root, cond) {
    if (!cond) return true;
    const current = currentFieldValue(root, cond.fieldKey);
    return cond.operator === "not_equals" ? current !== cond.value : current === cond.value;
  }

  function applyConditionals(root, fields) {
    fields.forEach((f) => {
      if (!f.conditional) return;
      const wrapper = root.querySelector(`[data-field-wrapper="${f.key}"]`);
      if (wrapper) wrapper.style.display = evalConditional(root, f.conditional) ? "" : "none";
    });
  }

  /** Call once after rendering fields into `root` - re-evaluates every
   * conditional field's visibility on any change/input inside the form. */
  function wireConditionals(root, fields) {
    const hasConditionals = fields.some((f) => f.conditional);
    if (!hasConditionals) return;
    applyConditionals(root, fields);
    root.addEventListener("change", () => applyConditionals(root, fields));
    root.addEventListener("input", () => applyConditionals(root, fields));
  }

  return { renderFields, collectValues, validate, showErrors, clearErrors, wireConditionals };
})();
