import { invoke } from "@tauri-apps/api/core";

export interface Site {
  cloudId: string;
  name: string;
  url: string;
}

export interface Account {
  accountId: string;
  name: string;
  avatarUrl: string | null;
}

export interface AuthStatus {
  configured: boolean;
  callbackUrl: string;
  scopes: string;
  site: Site | null;
  me: Account | null;
}

export const auth = {
  status: () => invoke<AuthStatus>("auth_status"),
  saveApp: (clientId: string, clientSecret: string) => invoke<AuthStatus>("save_oauth_app", { clientId, clientSecret }),
  signIn: () => invoke<AuthStatus>("sign_in"),
  signOut: () => invoke<void>("sign_out"),
};
