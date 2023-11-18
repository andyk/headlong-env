import { JsosSession } from "@andykon/jsos/src";

const supabaseUrlEnvName = "SUPABASE_URL_HEADLONG";
const supabaseKeyEnvName = "SUPABASE_SERVICE_ROLE_KEY_HEADLONG";

const jsos = new JsosSession()
    .addInMemory()
    .addSupabaseFromEnv(supabaseUrlEnvName, supabaseKeyEnvName);

const callback = (newVar) => console.log("updated var: " + newVar.selectedThought()[0].body)
jsos.subscribeToVar({ name: "headlong", namespace: "headlong-vite-v2", callback })

// Listen for SIGTERM signal
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received. Shutting down...');
    // Perform any cleanup operations here
    process.exit(0);
});
