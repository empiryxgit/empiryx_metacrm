#!/usr/bin/env node
// Prints fresh values for the two secrets this app must generate itself
// (they have no "sign up for an account" step like the other env vars).
// Run directly: node scripts/generate-secrets.js
// Called automatically by scripts/bootstrap.sh when .env is missing them.
const crypto = require("crypto");

console.log("AUTH_JWT_SECRET=" + crypto.randomBytes(48).toString("base64"));
console.log("ENCRYPTION_KEY=" + crypto.randomBytes(32).toString("base64"));
