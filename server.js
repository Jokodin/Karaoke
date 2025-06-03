// server.js
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

app.use(cors());
app.use(express.json());

const QUEUE_FILE = path.join(process.cwd(), "queue.json");

let queue = [];
if (fs.existsSync(QUEUE_FILE)) {
	try {
		const data = JSON.parse(fs.readFileSync(QUEUE_FILE));
		if (Array.isArray(data)) {
			queue = data;
		} else {
			console.warn("⚠ queue.json was not an array. Starting fresh.");
		}
	} catch (err) {
		console.error("⚠ Failed to parse queue.json. Starting fresh.");
	}
} else {
	// Create a fresh file
	fs.writeFileSync(QUEUE_FILE, JSON.stringify([]));
	console.log("✅ Created new queue.json");
}


function extractVideoId(url) {
	const match = url.match(/(?:v=|\.be\/)([a-zA-Z0-9_-]{11})/);
	return match ? match[1] : null;
}

async function getVideoTitle(videoId) {
	const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}&key=${YOUTUBE_API_KEY}`;
	const res = await fetch(apiUrl);
	const data = await res.json();

	if (!data.items?.[0]) {
		throw new Error("Video not found");
	}

	const video = data.items[0];
	if (!video.status.embeddable) {
		throw new Error("Video cannot be embedded");
	}

	return video.snippet.title || "Unknown Title";
}

app.post("/api/queue", async (req, res) => {
	const { url } = req.body;
	console.log("Received URL:", url);

	const videoId = extractVideoId(url);
	if (!videoId) {
		console.log("Invalid video ID extracted from URL");
		return res.status(400).json({ error: "Invalid YouTube URL" });
	}
	console.log("Extracted video ID:", videoId);

	try {
		// Check for duplicate video ID
		if (queue.some(video => extractVideoId(video.url) === videoId)) {
			console.log("Duplicate video detected");
			return res.status(400).json({ error: "This video is already in the queue" });
		}

		const title = await getVideoTitle(videoId);
		console.log("Fetched title:", title);

		const video = { url, title };
		queue.push(video);
		console.log("Current queue length:", queue.length);
		console.log("Queue contents:", queue);

		fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
		res.status(200).json({ success: true });
	} catch (err) {
		console.error("Error in POST /api/queue:", err);
		if (err.message === "Video cannot be embedded") {
			res.status(400).json({ error: "This video cannot be embedded. Please choose a different video." });
		} else {
			res.status(500).json({ error: "Failed to fetch video info" });
		}
	}
});

app.get("/api/queue", (req, res) => {
	console.log("GET /api/queue - Current queue:", queue);
	res.json(queue);
});

app.delete("/api/queue", (req, res) => {
	console.log("Clearing queue");
	queue = [];
	fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
	console.log("Queue cleared and saved");
	res.status(200).json({ success: true });
});

// Serve static files for frontends
app.use(express.static("public"));

app.listen(PORT, "0.0.0.0", () => {
	console.log(`Karaoke server running at http://localhost:${PORT}`);
});


