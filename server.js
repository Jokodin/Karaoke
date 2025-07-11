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
	const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
	const res = await fetch(apiUrl);
	const data = await res.json();

	if (!data.items?.[0]) {
		throw new Error("Video not found");
	}

	const video = data.items[0];

	// Check various embedding restrictions
	if (!video.status.embeddable) {
		throw new Error("Video cannot be embedded");
	}

	// Check if video is age restricted
	if (video.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") {
		throw new Error("Age-restricted videos cannot be embedded");
	}

	// Check if video is private or deleted
	if (video.status.privacyStatus === "private") {
		throw new Error("Private videos cannot be embedded");
	}

	return video.snippet.title || "Unknown Title";
}

app.post("/api/queue", async (req, res) => {
	const { url } = req.body;
	console.log("Received URL:", url);

	const videoId = extractVideoId(url);
	if (!videoId) {
		console.log("Invalid video ID extracted from URL");
		return res.status(400).json({
			error: "Invalid YouTube URL",
			details: "Please make sure you're using a valid YouTube video URL"
		});
	}
	console.log("Extracted video ID:", videoId);

	try {
		// Check for duplicate video ID
		if (queue.some(video => extractVideoId(video.url) === videoId)) {
			console.log("Duplicate video detected");
			return res.status(400).json({
				error: "This video is already in the queue",
				details: "The same video has already been added to the queue"
			});
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
			res.status(400).json({
				error: "This video cannot be embedded",
				details: "Some YouTube channels like Karafun and SingKing do not allow embedding. Try to find your song on a different channel.",
				type: "embedding"
			});
		} else if (err.message === "Age-restricted videos cannot be embedded") {
			res.status(400).json({
				error: "Age-restricted video cannot be embedded",
				details: "This video has age restrictions that prevent it from being embedded in external players.",
				type: "age-restricted"
			});
		} else if (err.message === "Private videos cannot be embedded") {
			res.status(400).json({
				error: "Private video cannot be embedded",
				details: "This video is private and cannot be accessed or embedded.",
				type: "private"
			});
		} else if (err.message === "Video not found") {
			res.status(400).json({
				error: "Video not found",
				details: "The video may have been deleted, made private, or the URL is incorrect.",
				type: "not-found"
			});
		} else {
			res.status(500).json({
				error: "Failed to fetch video info",
				details: "There was an error processing your request. Please try again.",
				type: "server-error"
			});
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


