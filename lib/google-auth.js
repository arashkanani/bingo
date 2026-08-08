const { OAuth2Client } = require("google-auth-library");

function getGoogleClientId() {
  const id = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  return id || null;
}

async function verifyGoogleIdToken(idToken) {
  const clientId = getGoogleClientId();
  if (!clientId) {
    throw new Error("Google sign-in is not configured on this server.");
  }
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken: String(idToken || "").trim(),
    audience: clientId
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error("Invalid Google sign-in.");
  }
  if (!payload.email) {
    throw new Error("Your Google account has no email address.");
  }
  if (payload.email_verified === false) {
    throw new Error("Please verify your Google email address first.");
  }
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || "",
    picture: payload.picture || ""
  };
}

module.exports = {
  getGoogleClientId,
  verifyGoogleIdToken
};
