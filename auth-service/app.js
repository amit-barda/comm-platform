// =============================================================================
// auth-service — Google OAuth -> JWT bridge for Jitsi Meet
// -----------------------------------------------------------------------------
// All HTTP routes live under /oauth so that nginx can transparently mount this
// service alongside Jitsi on the SAME public domain (https://video.<...>):
//
//     /oauth/healthz              liveness probe
//     /oauth/google               start Google OAuth (kicks off via TOKEN_AUTH_URL)
//     /oauth/google/callback      Google's redirect target -> sign JWT -> bounce to Jitsi
// =============================================================================

const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');

const app = express();

const PORT             = process.env.PORT || 3001;
const PUBLIC_BASE_URL  = process.env.PUBLIC_BASE_URL  || 'https://video.think-deploy.com/oauth';
const JITSI_PUBLIC_URL = process.env.JITSI_PUBLIC_URL || 'https://video.think-deploy.com';
const JWT_APP_ID       = process.env.JWT_APP_ID       || 'thinkdeploy';
const JWT_AUDIENCE     = process.env.JWT_AUDIENCE     || JWT_APP_ID;
const JWT_ISSUER       = process.env.JWT_ISSUER       || JWT_APP_ID;
const JWT_SUB          = process.env.JWT_SUB          || 'meet.jitsi';

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn('[auth-service] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — OAuth will fail.');
}
if (!process.env.JWT_SECRET) {
  console.warn('[auth-service] JWT_SECRET is not set — token signing will fail.');
}

passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${PUBLIC_BASE_URL}/google/callback`,
  },
  (_accessToken, _refreshToken, profile, done) => done(null, profile)
));

app.use(passport.initialize());

app.get('/oauth/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

app.get('/oauth/google', (req, res, next) => {
  // Round-trip the room name through OAuth `state` so the user lands back in
  // the right room after the consent screen.
  const room = (req.query.room && /^[A-Za-z0-9_-]{1,64}$/.test(req.query.room))
    ? req.query.room
    : '';
  const state = Buffer.from(JSON.stringify({ room })).toString('base64url');
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state,
  })(req, res, next);
});

app.get('/oauth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/oauth/healthz' }),
  (req, res) => {
    let room = 'lobby';
    try {
      const decoded = JSON.parse(Buffer.from(req.query.state || '', 'base64url').toString('utf8'));
      if (decoded.room && /^[A-Za-z0-9_-]{1,64}$/.test(decoded.room)) room = decoded.room;
    } catch (_) { /* fall back to default room */ }

    const token = jwt.sign(
      {
        aud: JWT_AUDIENCE,
        iss: JWT_ISSUER,
        sub: JWT_SUB,
        room: '*',
        exp: Math.floor(Date.now() / 1000) + 3600,
        context: {
          user: {
            name:  req.user && req.user.displayName,
            email: req.user && req.user.emails && req.user.emails[0] && req.user.emails[0].value,
          },
        },
      },
      process.env.JWT_SECRET
    );

    res.redirect(`${JITSI_PUBLIC_URL}/${room}?jwt=${token}`);
  }
);

app.listen(PORT, () => console.log(`auth-service listening on :${PORT}`));
