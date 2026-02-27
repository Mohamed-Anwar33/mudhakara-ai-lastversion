async function triggerQueue() {
    try {
        console.log("Triggering process-queue API...");
        const res = await fetch("https://mudhakara-ai-lastversion.vercel.app/api/process-queue", {
            method: "POST"
        });
        const text = await res.text();
        console.log("Response:", res.status, text);
    } catch (err) {
        console.error("Error triggering queue:", err);
    }
}
triggerQueue();
