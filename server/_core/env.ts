export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  tursoUrl: process.env.TURSO_DATABASE_URL ?? "",
  tursoToken: process.env.TURSO_AUTH_TOKEN ?? process.env.turso_tagbaixada ?? "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "https://go.rsadigitalconsultoria.com.br",
  appBaseUrl: process.env.APP_BASE_URL ?? "https://app.rsadigitalconsultoria.com.br",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
