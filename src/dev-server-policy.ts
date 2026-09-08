// Keep Vite's default deny patterns alongside the local-state protections (#429).
export const DEV_SERVER_FS_DENY: string[] = [
  "**/bridge-config.generated.js",
  "**/ResonantOS_User/**",
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
];
