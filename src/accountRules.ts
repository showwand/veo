// Username and password rules. The username rule matches the database constraint
// (^[a-z0-9_]{3,20}$) exactly, so the app and the database always agree.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72; // longer passwords are silently cut off by the password hashing

// "ShowWand" and "showwand" are the same username
export function normaliseUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function validateUsername(username: string): string | null {
  if (username.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters.`;
  if (username.length > USERNAME_MAX) return `Username can be at most ${USERNAME_MAX} characters.`;
  if (!/^[a-z0-9_]+$/.test(username)) return "Use only letters, numbers and underscores.";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password can be at most ${PASSWORD_MAX} characters.`;
  return null;
}