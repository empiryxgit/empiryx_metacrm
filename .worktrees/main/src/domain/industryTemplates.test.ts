// Pure, DB-free tests for the industry-template system's core promise:
// "The CRM must function without selecting one" and "Do not implement
// if real_estate -> CRM A / if solar -> CRM B". See this file's own header
// comment in industryTemplates.ts for the full architecture rule these
// tests exist to guard.

import { describe, expect, it } from "vitest";
import {
  GENERAL_TEMPLATE,
  INDUSTRY_KEYS,
  INDUSTRY_TEMPLATES,
  SELECTABLE_BUILT_IN_TEMPLATES,
  buildCustomIndustryTemplate,
  getIndustryTemplate,
  resolveEffectiveIndustryTemplate,
  validateCustomTemplateConfig,
  type CustomTemplateConfig,
} from "./industryTemplates";

function validConfig(overrides: Partial<CustomTemplateConfig> = {}): unknown {
  return {
    name: "My Sales Process",
    pipelineName: "Sales Pipeline",
    stages: [
      { key: "new", label: "New", isInitial: true },
      { key: "won", label: "Won", isClosed: true, isWon: true },
    ],
    fields: [],
    ...overrides,
  };
}

describe("getIndustryTemplate - 'no template selected' must be a fully-functional state", () => {
  it("returns GENERAL_TEMPLATE for undefined", () => {
    expect(getIndustryTemplate(undefined)).toBe(GENERAL_TEMPLATE);
  });

  it("returns GENERAL_TEMPLATE for null", () => {
    expect(getIndustryTemplate(null)).toBe(GENERAL_TEMPLATE);
  });

  it("returns GENERAL_TEMPLATE for an empty string", () => {
    expect(getIndustryTemplate("")).toBe(GENERAL_TEMPLATE);
  });

  it("returns GENERAL_TEMPLATE for an unrecognized/legacy key - never silently falls back to a specific industry", () => {
    expect(getIndustryTemplate("some_removed_industry")).toBe(GENERAL_TEMPLATE);
    expect(getIndustryTemplate("real_estate_v1")).toBe(GENERAL_TEMPLATE);
  });

  it("GENERAL_TEMPLATE itself is a real, usable Core-CRM-only shape: a stage set, zero required specialization, no milestone", () => {
    expect(GENERAL_TEMPLATE.key).toBe("general");
    expect(GENERAL_TEMPLATE.stages.length).toBeGreaterThan(0);
    expect(GENERAL_TEMPLATE.stages.some((s) => s.isInitial)).toBe(true);
    expect(GENERAL_TEMPLATE.fields).toEqual([]);
    expect(GENERAL_TEMPLATE.milestoneLabel).toBe("");
  });

  it("every real industry key still resolves to its own distinct built-in template (existing functionality preserved, not removed)", () => {
    expect(getIndustryTemplate("real_estate").key).toBe("real_estate");
    expect(getIndustryTemplate("solar").key).toBe("solar");
    expect(getIndustryTemplate("healthcare").key).toBe("healthcare");
    expect(getIndustryTemplate("education").key).toBe("education");
    expect(getIndustryTemplate("ecommerce").key).toBe("ecommerce");
  });

  it("INDUSTRY_KEYS / INDUSTRY_TEMPLATES / SELECTABLE_BUILT_IN_TEMPLATES all agree on the catalog", () => {
    for (const key of INDUSTRY_KEYS) {
      expect(INDUSTRY_TEMPLATES[key]).toBeDefined();
    }
    // "custom" has no fixed preview shape of its own - never offered as a
    // static preview card, only ever built live from a company's own config.
    expect(SELECTABLE_BUILT_IN_TEMPLATES.some((t) => t.key === "custom")).toBe(false);
    expect(SELECTABLE_BUILT_IN_TEMPLATES.length).toBe(INDUSTRY_KEYS.length - 1);
  });

  it("getIndustryTemplate('custom') alone (no config) is always the same safe generic placeholder, not a crash or undefined shape", () => {
    expect(getIndustryTemplate("custom")).toBe(GENERAL_TEMPLATE);
  });
});

describe("validateCustomTemplateConfig", () => {
  it("accepts a well-formed config", () => {
    const result = validateCustomTemplateConfig(validConfig());
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateCustomTemplateConfig(null).ok).toBe(false);
    expect(validateCustomTemplateConfig("nope").ok).toBe(false);
    expect(validateCustomTemplateConfig([]).ok).toBe(false);
  });

  it("rejects a missing/blank name", () => {
    const result = validateCustomTemplateConfig(validConfig({ name: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing pipelineName", () => {
    const result = validateCustomTemplateConfig(validConfig({ pipelineName: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects zero stages", () => {
    const result = validateCustomTemplateConfig(validConfig({ stages: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects no isInitial stage", () => {
    const result = validateCustomTemplateConfig(
      validConfig({ stages: [{ key: "new", label: "New" }, { key: "won", label: "Won" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/initial/i);
  });

  it("rejects two isInitial stages", () => {
    const result = validateCustomTemplateConfig(
      validConfig({
        stages: [
          { key: "new", label: "New", isInitial: true },
          { key: "open", label: "Open", isInitial: true },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only one|initial/i);
  });

  it("rejects duplicate stage keys", () => {
    const result = validateCustomTemplateConfig(
      validConfig({
        stages: [
          { key: "new", label: "New", isInitial: true },
          { key: "new", label: "New Again" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid (non lowercase_snake_case) stage key", () => {
    const result = validateCustomTemplateConfig(
      validConfig({ stages: [{ key: "New Stage!", label: "New", isInitial: true }] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a field key colliding with a system field key", () => {
    const result = validateCustomTemplateConfig(
      validConfig({ fields: [{ key: "notes", label: "Notes", type: "text" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reserved/i);
  });

  it("rejects duplicate field keys", () => {
    const result = validateCustomTemplateConfig(
      validConfig({
        fields: [
          { key: "budget", label: "Budget", type: "number" },
          { key: "budget", label: "Budget Again", type: "text" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid field type", () => {
    // Deliberately an invalid `type` to exercise the runtime check - not
    // expressible in CustomTemplateConfig's own FieldType union, so this one
    // case bypasses validConfig()'s typed helper.
    const result = validateCustomTemplateConfig({
      name: "My Sales Process",
      pipelineName: "Sales Pipeline",
      stages: [{ key: "new", label: "New", isInitial: true }],
      fields: [{ key: "widget", label: "Widget", type: "not_a_real_type" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a select field with no options", () => {
    const result = validateCustomTemplateConfig(
      validConfig({ fields: [{ key: "tier", label: "Tier", type: "select", options: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/option/i);
  });

  it("accepts a select field with options", () => {
    const result = validateCustomTemplateConfig(
      validConfig({ fields: [{ key: "tier", label: "Tier", type: "select", options: ["Gold", "Silver"] }] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects more than 20 stages", () => {
    const stages = Array.from({ length: 21 }, (_, i) => ({ key: `stage_${i}`, label: `Stage ${i}`, isInitial: i === 0 }));
    const result = validateCustomTemplateConfig(validConfig({ stages }));
    expect(result.ok).toBe(false);
  });

  it("rejects more than 30 fields", () => {
    const fields = Array.from({ length: 31 }, (_, i) => ({ key: `field_${i}`, label: `Field ${i}`, type: "text" as const }));
    const result = validateCustomTemplateConfig(validConfig({ fields }));
    expect(result.ok).toBe(false);
  });

  it("accepts exactly 20 stages and 30 fields (boundary, not off-by-one)", () => {
    const stages = Array.from({ length: 20 }, (_, i) => ({ key: `stage_${i}`, label: `Stage ${i}`, isInitial: i === 0 }));
    const fields = Array.from({ length: 30 }, (_, i) => ({ key: `field_${i}`, label: `Field ${i}`, type: "text" as const }));
    const result = validateCustomTemplateConfig(validConfig({ stages, fields }));
    expect(result.ok).toBe(true);
  });
});

describe("buildCustomIndustryTemplate / resolveEffectiveIndustryTemplate", () => {
  it("wraps a validated config's own fields with the universal SYSTEM_FIELDS_LEAD/CRM envelope", () => {
    const validated = validateCustomTemplateConfig(
      validConfig({ fields: [{ key: "widget_count", label: "Widget Count", type: "number" }] }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const template = buildCustomIndustryTemplate(validated.config);
    expect(template.key).toBe("custom");
    expect(template.fields.map((f) => f.key)).toEqual(["widget_count"]);
    const formFieldKeys = template.defaultFormFields.map((f) => f.key ?? f.systemField);
    expect(formFieldKeys).toContain("fullName");
    expect(formFieldKeys).toContain("phoneNumber");
  });

  it("resolveEffectiveIndustryTemplate builds the real custom shape when industryKey is 'custom' and config is valid", () => {
    const config = validConfig();
    const effective = resolveEffectiveIndustryTemplate("custom", config);
    expect(effective.name).toBe("My Sales Process");
    expect(effective.stages.map((s) => s.key)).toEqual(["new", "won"]);
  });

  it("resolveEffectiveIndustryTemplate falls back safely to the generic shape when config is absent", () => {
    const effective = resolveEffectiveIndustryTemplate("custom", null);
    expect(effective).toBe(GENERAL_TEMPLATE);
  });

  it("resolveEffectiveIndustryTemplate falls back safely to the generic shape when config is present but invalid (defends a hand-edited/legacy row)", () => {
    const effective = resolveEffectiveIndustryTemplate("custom", { name: "" });
    expect(effective).toBe(GENERAL_TEMPLATE);
  });

  it("resolveEffectiveIndustryTemplate ignores a stored customTemplateConfig when industryKey isn't 'custom'", () => {
    const effective = resolveEffectiveIndustryTemplate("real_estate", validConfig());
    expect(effective.key).toBe("real_estate");
  });

  it("resolveEffectiveIndustryTemplate behaves exactly like getIndustryTemplate for every non-custom key regardless of config", () => {
    for (const key of INDUSTRY_KEYS.filter((k) => k !== "custom")) {
      expect(resolveEffectiveIndustryTemplate(key, validConfig())).toBe(getIndustryTemplate(key));
    }
  });
});
