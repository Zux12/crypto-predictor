import express from "express";
import mongoose from "mongoose";

// Heroku provides env vars automatically.
// Locally, create a .env with MONGO_URI, JWT_SECRET, TIMEZONE.
const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI;
const TZ_DISPLAY = process.env.TIMEZONE || "UTC";

const app = express();

// Serve static files (dashboard shell)
app.use(express.static("public"));

// Health endpoint (no secrets)
app.get("/health", (req, res) => {
  const up = process.uptime();
  res.json({
    status: "ok",
    uptime_s: Math.round(up),
    timezone: TZ_DISPLAY,
    mongo_connected: mongoose.connection.readyState === 1
  });
});

// Root → serves /public/index.html
app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

// Start server first; connect to Mongo in the background
app.listen(PORT, () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
  if (!MONGO_URI) {
    console.warn("⚠️  MONGO_URI is missing. Set it in Heroku Config Vars.");
    return;
  }
  mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("✅ MongoDB connected"))
    .catch(err => console.error("❌ MongoDB connection error:", err.message));
});
