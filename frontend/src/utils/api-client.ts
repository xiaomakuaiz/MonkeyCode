import { Api } from "@/api/Api"
import { getApiBaseUrl } from "@/utils/api-base-url"

export function createApiClient() {
  return new Api({
    baseUrl: getApiBaseUrl(),
  })
}
