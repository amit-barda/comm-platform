const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const jwt = require('jsonwebtoken');

const app = express();

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "https://auth.think-deploy.com/auth/google/callback"
  },
  function(accessToken, refreshToken, profile, done) {
    return done(null, profile);
  }
));

app.use(passport.initialize());

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile','email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false }),
  (req, res) => {

    const token = jwt.sign({
      aud: "thinkdeploy",
      iss: "thinkdeploy",
      sub: "video.think-deploy.com",
      room: "*",
      exp: Math.floor(Date.now()/1000) + 3600,
      context: {
        user: {
          name: req.user.displayName,
          email: req.user.emails[0].value
        }
      }
    }, process.env.JWT_SECRET);

    res.redirect(`https://video.think-deploy.com/test?jwt=${token}`);
  }
);

app.listen(3001, () => console.log("Auth running on 3001"));
