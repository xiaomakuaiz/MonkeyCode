export const APP_PROFILES = ["web", "mobile"] as const

export type AppProfile = (typeof APP_PROFILES)[number]

const rawAppProfile = import.meta.env.VITE_APP_PROFILE

export const APP_PROFILE: AppProfile = APP_PROFILES.includes(rawAppProfile as AppProfile)
  ? (rawAppProfile as AppProfile)
  : "web"

export const IS_WEB_PROFILE = APP_PROFILE === "web"
export const IS_MOBILE_PROFILE = APP_PROFILE === "mobile"
