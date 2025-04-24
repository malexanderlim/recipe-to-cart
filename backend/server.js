require('dotenv').config({ path: require('path').resolve(__dirname, './.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');

// --- Basic App Setup ---
const app = express();
const port = process.env.PORT || 3001;
const isVercel = process.env.VERCEL === '1';

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins
app.use(express.json({ limit: '10mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Increase URL-encoded payload limit

// --- Multer Setup (for file uploads) ---
// Multer is configured here because the 'upload' instance is used directly in the upload route definition
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Route Imports ---
const uploadRoutes = require('./routes/uploadRoutes');
const processImageRoutes = require('./routes/processImageRoutes');
// const processTextRoutes = require('./routes/processTextRoutes'); // Remove old route
const processTextWorkerRoutes = require('./routes/processTextWorkerRoutes'); // Import new worker route
const urlRoutes = require('./routes/urlRoutes');
const urlJobRoutes = require('./routes/urlJobRoutes');
const jobStatusRoutes = require('./routes/jobStatusRoutes');
const listRoutes = require('./routes/listRoutes');
const instacartRoutes = require('./routes/instacartRoutes');

// --- API Routes --- 
// Apply the upload middleware specifically to the upload route
app.use('/api/upload', uploadRoutes);
app.use('/api/process-image', processImageRoutes);
// app.use('/api/process-text', processTextRoutes); // Remove old route mounting
app.use('/api/process-text-worker', processTextWorkerRoutes); // Mount new worker route
app.use('/api/process-url', urlRoutes);
app.use('/api/process-url-job', urlJobRoutes);
app.use('/api/job-status', jobStatusRoutes);
app.use('/api/create-list', listRoutes);
app.use('/api/send-to-instacart', instacartRoutes);

// --- Basic Root Route --- 
app.get('/', (req, res) => {
    res.send('Recipe-to-Cart Backend is running!');
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    if (!isVercel) {
        console.log(`Local development mode active.`); // Removed mock KV mention
    }
});

// Export the app for Vercel
module.exports = app;