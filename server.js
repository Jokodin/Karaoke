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

// Add cache-busting headers for static files
app.use((req, res, next) => {
	// Prevent caching for HTML files and API endpoints
	if (req.path.endsWith('.html') || req.path.startsWith('/api/')) {
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
		res.setHeader('Pragma', 'no-cache');
		res.setHeader('Expires', '0');
	}
	next();
});

const QUEUE_FILE = path.join(process.cwd(), "queue.json");
const SETTINGS_FILE = path.join(process.cwd(), "settings.json");
const PLAYING_FILE = path.join(process.cwd(), "playing.json");

let queue = [];
let settings = { allowDuplicates: false }; // Default to false
let nowPlaying = null; // { index, url, title } or null

// Load queue
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

// Load settings
if (fs.existsSync(SETTINGS_FILE)) {
	try {
		const data = JSON.parse(fs.readFileSync(SETTINGS_FILE));
		settings = { ...settings, ...data };
	} catch (err) {
		console.error("⚠ Failed to parse settings.json. Using defaults.");
	}
} else {
	// Create a fresh settings file
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
	console.log("✅ Created new settings.json");
}

// Load the song that was playing so a page refresh can resume it
if (fs.existsSync(PLAYING_FILE)) {
	try {
		const data = JSON.parse(fs.readFileSync(PLAYING_FILE));
		if (data && Number.isInteger(data.index)) {
			nowPlaying = data;
		}
	} catch (err) {
		console.error("⚠ Failed to parse playing.json. Starting with nothing playing.");
	}
}

function saveNowPlaying() {
	fs.writeFileSync(PLAYING_FILE, JSON.stringify(nowPlaying, null, 2));
}

function resolveNowPlaying() {
	if (!nowPlaying || queue.length === 0) return null;

	const index = nowPlaying.index;
	if (Number.isInteger(index) && index >= 0 && index < queue.length) {
		const atIndex = queue[index];
		if (!nowPlaying.url || atIndex.url === nowPlaying.url) {
			return { index, url: atIndex.url, title: atIndex.title };
		}
	}

	if (nowPlaying.url) {
		const byUrl = queue.findIndex((video) => video.url === nowPlaying.url);
		if (byUrl !== -1) {
			return { index: byUrl, url: queue[byUrl].url, title: queue[byUrl].title };
		}
	}

	return null;
}


function extractVideoId(url) {
	const match = url.match(/(?:v=|\.be\/)([a-zA-Z0-9_-]{11})/);
	return match ? match[1] : null;
}

async function getVideoInfo(videoId) {
	const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,contentDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
	const res = await fetch(apiUrl);
	const data = await res.json();

	if (!data.items?.[0]) {
		throw new Error("Video not found");
	}

	const video = data.items[0];

	// Check if video is private or deleted
	if (video.status.privacyStatus === "private") {
		throw new Error("Private videos cannot be embedded");
	}

	// Parse duration (ISO 8601 format like PT4M13S)
	const duration = video.contentDetails?.duration || "PT0S";
	const durationSeconds = parseDuration(duration);

	const isEmbeddable = video.status.embeddable === true;
	const isAgeRestricted = video.contentDetails?.contentRating?.ytRating === "ytAgeRestricted";

	return {
		title: video.snippet.title || "Unknown Title",
		duration: durationSeconds,
		embeddable: isEmbeddable && !isAgeRestricted
	};
}

function parseDuration(duration) {
	// Parse ISO 8601 duration (e.g., PT4M13S = 4 minutes 13 seconds)
	const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
	if (!match) return 0;

	const hours = parseInt(match[1] || 0);
	const minutes = parseInt(match[2] || 0);
	const seconds = parseInt(match[3] || 0);

	return hours * 3600 + minutes * 60 + seconds;
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
			if (!settings.allowDuplicates) {
				return res.status(400).json({
					error: "This video is already in the queue",
					details: "The same video has already been added to the queue. Duplicates are not allowed.",
					type: "duplicate"
				});
			}
		}

		const videoInfo = await getVideoInfo(videoId);
		console.log("Fetched video info:", videoInfo);

		const video = {
			url,
			title: videoInfo.title,
			duration: videoInfo.duration,
			embeddable: videoInfo.embeddable
		};
		queue.push(video);
		console.log("Current queue length:", queue.length);
		console.log("Queue contents:", queue);

		fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
		res.status(200).json({ success: true });
	} catch (err) {
		console.error("Error in POST /api/queue:", err);

		if (err.message === "Private videos cannot be embedded") {
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
	// console.log("GET /api/queue - Current queue:", queue);
	res.json(queue);
});

app.get("/api/duplicate-setting", (req, res) => {
	console.log("GET /api/duplicate-setting - Current setting:", settings.allowDuplicates);
	res.json({ allowDuplicates: settings.allowDuplicates });
});

app.post("/api/duplicate-setting", (req, res) => {
	const { allowDuplicates } = req.body;

	if (typeof allowDuplicates !== "boolean") {
		return res.status(400).json({
			error: "Invalid setting value",
			details: "allowDuplicates must be a boolean value"
		});
	}

	settings.allowDuplicates = allowDuplicates;
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

	console.log("POST /api/duplicate-setting - Updated setting:", settings.allowDuplicates);
	res.json({ success: true, allowDuplicates: settings.allowDuplicates });
});

app.delete("/api/queue", (req, res) => {
	console.log("Clearing queue");
	queue = [];
	nowPlaying = null;
	fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
	saveNowPlaying();
	console.log("Queue cleared and saved");
	res.status(200).json({ success: true });
});

app.get("/api/now-playing", (req, res) => {
	const current = resolveNowPlaying();
	res.json(current ?? { index: null });
});

app.post("/api/now-playing", (req, res) => {
	const { index } = req.body;

	if (index === null) {
		nowPlaying = null;
		saveNowPlaying();
		return res.json({ success: true, nowPlaying: null });
	}

	if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
		return res.status(400).json({
			error: "Invalid now-playing index",
			details: "index must point at a song currently in the queue"
		});
	}

	const video = queue[index];
	nowPlaying = { index, url: video.url, title: video.title };
	saveNowPlaying();
	console.log("Now playing:", nowPlaying.title, "at index", index);
	res.json({ success: true, nowPlaying });
});

// 404 handler for unmatched API routes - must be before static file serving
app.use((req, res, next) => {
	if (req.path.startsWith("/api/") && !res.headersSent) {
		res.status(404).json({
			error: "API endpoint not found",
			details: `The endpoint ${req.path} does not exist.`
		});
	} else {
		next();
	}
});

// Error handling middleware - must be before static file serving
app.use((err, req, res, next) => {
	// Only handle errors for API routes
	if (req.path.startsWith("/api/")) {
		console.error("Unhandled error in API route:", err);
		res.status(500).json({
			error: "Internal server error",
			details: "An unexpected error occurred. Please try again.",
			type: "server-error"
		});
	} else {
		// For non-API routes, pass to next handler
		next(err);
	}
});

// Serve static files for frontends
app.use(express.static("public"));

app.listen(PORT, "0.0.0.0", () => {
	console.log(`Karaoke server running at http://localhost:${PORT}`);
});


