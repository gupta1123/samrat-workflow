export function signInErrorMessage(error: {
  status?: number;
  message?: string;
}) {
  if (error.status === 0) {
    return "Unable to complete the connection to Samrat. Please try signing in again.";
  }
  if (error.status === 429) {
    return "Too many sign-in attempts. Please wait a few minutes and try again.";
  }
  return error.message || "Sign-in could not be completed. Please try again.";
}
