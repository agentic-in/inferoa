import { resumeSessionPage, type ResumeSessionPage } from "./session-picker.js";
import type { ExternalProviderSetupOption } from "../model/providers.js";

export const PROVIDER_PICKER_PAGE_SIZE = 5;

export function providerPickerPage(
  options: readonly ExternalProviderSetupOption[],
  pageIndex: number,
): ResumeSessionPage<ExternalProviderSetupOption> {
  return resumeSessionPage(options, pageIndex, PROVIDER_PICKER_PAGE_SIZE);
}

export function filterProviderPickerOptions(
  options: readonly ExternalProviderSetupOption[],
  query: string,
): ExternalProviderSetupOption[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [...options];
  }
  return options.filter((option) => {
    const provider = option.provider;
    return [
      provider.id,
      provider.label,
      provider.description,
      provider.base_url ?? "",
      provider.default_model ?? "",
      provider.provider_kind,
      provider.model_hints.join(" "),
      option.description,
    ].join(" ").toLowerCase().includes(normalized);
  });
}
