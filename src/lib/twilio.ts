import twilio from 'twilio';

export function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

export function twilioClient() {
  if (!twilioConfigured()) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
}

/**
 * Mint a short-lived Voice access token so the browser (Twilio Voice JS SDK)
 * can place and receive calls as the rep's identity. Requires an API Key/Secret
 * and a TwiML App whose Voice URL points at /api/voice/outbound.
 */
export function voiceAccessToken(identity: string): string | null {
  const {
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    TWILIO_TWIML_APP_SID,
  } = process.env;
  if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_API_KEY_SID ||
    !TWILIO_API_KEY_SECRET ||
    !TWILIO_TWIML_APP_SID
  )
    return null;

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );
  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true, // let the rep receive inbound calls in-app
    })
  );
  return token.toJwt();
}
