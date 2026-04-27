const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');

const app = express();

const PORT = process.env.PORT || 3001;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://auth.think-deploy.com';
const JITSI_PUBLIC_URL = process.env.JITSI_PUBLIC_URL || 'https://video.think-deploy.com';
const JWT_APP_ID = process.env.JWT_APP_ID || 'thinkdeploy';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || JWT_APP_ID;
const JWT_ISSUER = process.env.JWT_ISSUER || JWT_APP_ID;
const JWT_SUB = process.env.JWT_SUB || 'meet.jitsi';

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${PUBLIC_BASE_URL}/auth/google/callback`
  },
  function (accessToken, refreshToken, profile, done) {
    return done(null, profile);
  }
));

app.use(passport.initialize());

app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

app.get('/auth/google', (req, res, next) => {
  // Carry the requested room (sent via TOKEN_AUTH_URL `?room={room}`) through
  // the OAuth round-trip via the `state` parameter.
  const room = (req.query.room && /^[A-Za-z0-9_-]{1,64}$/.test(req.query.room))
    ? req.query.room : '';
  const state = Buffer.from(JSON.stringify({ room })).toString('base64url');
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state
  })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false }),
  (req, res) => {
    let room = 'test';
    try {
      const decoded = JSON.parse(Buffer.from(req.query.state || '', 'base64url').toString('utf8'));
      if (decoded.room && /^[A-Za-z0-9_-]{1,64}$/.test(decoded.room)) room = decoded.room;
    } catch (_) { /* fall back to 'test' */ }

    const token = jwt.sign({
      aud: JWT_AUDIENCE,
      iss: JWT_ISSUER,
      sub: JWT_SUB,
      room: '*',
      exp: Math.floor(Date.now() / 1000) + 3600,
      context: {
        user: {
          name: req.user.displayName,
          email: req.user.emails[0].value
        }
      }
    }, process.env.JWT_SECRET);

    res.redirect(`${JITSI_PUBLIC_URL}/${room}?jwt=${token}`);
  }
);

app.listen(PORT, () => console.log(`Auth running on ${PORT}`));
