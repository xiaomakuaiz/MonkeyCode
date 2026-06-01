import { Api } from "@/api/Api"
import { getApiBaseUrl } from "@/utils/api-base-url"
import { IS_MOBILE_PROFILE } from "@/utils/app-profile"

export function createApiClient() {
  return new Api({
    baseUrl: getApiBaseUrl(),
    baseApiParams: {
      credentials: IS_MOBILE_PROFILE ? "include" : "same-origin",
    },
  })
}
