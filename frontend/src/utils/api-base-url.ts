import { IS_MOBILE_PROFILE } from "@/utils/app-profile"

const DEFAULT_ONLINE_API_ORIGIN = "https://monkeycode-ai.com"

export function getApiBaseUrl(): string {
  const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

  if (configuredApiBaseUrl) {
    return configuredApiBaseUrl.replace(/\/$/, "")
  }

  if (IS_MOBILE_PROFILE) {
    return DEFAULT_ONLINE_API_ORIGIN
  }

  return ""
}
