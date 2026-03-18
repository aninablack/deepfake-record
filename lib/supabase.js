const { createClient } = require("@supabase/supabase-js");
const { config, requireEnv } = require("./config");

function getServiceClient() {
  const url = requireEnv("SUPABASE_URL", config.supabaseUrl);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY", config.supabaseServiceRoleKey);
  return createClient(url, key, { auth: { persistSession: false } });
}

function getAnonClient() {
  const url = requireEnv("SUPABASE_URL", config.supabaseUrl);
  const key = requireEnv("SUPABASE_ANON_KEY", config.supabaseAnonKey);
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = { getServiceClient, getAnonClient };
