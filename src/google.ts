import { google, docs_v1, drive_v3 } from "googleapis";
import { GoogleAuthConfig } from "./config.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.readonly",
];

export interface GoogleClients {
  docs: docs_v1.Docs;
  drive: drive_v3.Drive;
}

function buildAuthClient(auth: GoogleAuthConfig) {
  if (auth.mode === "oauth") {
    const oauth2 = new google.auth.OAuth2(auth.clientId, auth.clientSecret);
    oauth2.setCredentials({ refresh_token: auth.refreshToken });
    return oauth2;
  }
  return new google.auth.GoogleAuth({
    credentials: auth.credentials as Record<string, string>,
    scopes: GOOGLE_SCOPES,
  });
}

export function createGoogleClients(authConfig: GoogleAuthConfig): GoogleClients {
  const auth = buildAuthClient(authConfig);
  return {
    docs: google.docs({ version: "v1", auth }),
    drive: google.drive({ version: "v3", auth }),
  };
}
