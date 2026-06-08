import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PICKER_PAGE_SIZE, filterProviderPickerOptions, providerPickerPage } from "../src/tui/provider-picker.js";
import type { ExternalProviderSetupOption } from "../src/model/providers.js";

const options: ExternalProviderSetupOption[] = Array.from({ length: 13 }, (_, index) => ({
  provider: {
    id: `provider-${index + 1}`,
    label: `Provider ${index + 1}`,
    description: `Hosted model provider ${index + 1}`,
    base_url: `https://provider-${index + 1}.example/v1`,
    default_model: `model-${index + 1}`,
    profile: "openai_compatible",
    auth_type: "api_key",
    provider_kind: "first_party",
    model_hints: [`model-${index + 1}`],
    env_var_names: [],
    supports_custom_base_url: false,
    listing_priority: index + 1,
  },
  discovered: index === 9,
  description: index === 9 ? "auto · env:PROVIDER_10_API_KEY" : "key required",
}));

test("provider picker pages five rows like resume selection", () => {
  const first = providerPickerPage(options, 0);
  const second = providerPickerPage(options, 1);
  const last = providerPickerPage(options, 99);

  assert.equal(PROVIDER_PICKER_PAGE_SIZE, 5);
  assert.deepEqual(first.items.map((option) => option.provider.id), ["provider-1", "provider-2", "provider-3", "provider-4", "provider-5"]);
  assert.deepEqual(second.items.map((option) => option.provider.id), ["provider-6", "provider-7", "provider-8", "provider-9", "provider-10"]);
  assert.deepEqual(last.items.map((option) => option.provider.id), ["provider-11", "provider-12", "provider-13"]);
});

test("provider picker filters by provider text and keeps discovered matches", () => {
  const filtered = filterProviderPickerOptions(options, "provider 10");

  assert.deepEqual(filtered.map((option) => option.provider.id), ["provider-10"]);
  assert.equal(filtered[0]?.discovered, true);
});
