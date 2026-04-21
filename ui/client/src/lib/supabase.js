import { createClient } from '@supabase/supabase-js';

const url  = import.meta.env.VITE_SUPABASE_URL;
const key  = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.warn('[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is not set. Auth features will be disabled.');
}

export const supabase = (url && key)
  ? createClient(url, key, {
      auth: {
        persistSession:    true,
        storageKey:        'autocloser-auth',
        autoRefreshToken:  true,
        detectSessionInUrl: false,  // Electron: no URL-based auth callbacks
      },
    })
  : null;
