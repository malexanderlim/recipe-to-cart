require('dotenv').config({ path: require('path').resolve(__dirname, './.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer'); // Uncommented

// --- Basic App Setup ---
const app = express();
const port = process.env.PORT || 3001;
const isVercel = process.env.VERCEL === '1'; // Uncommented

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- Multer Setup (for file uploads) ---
const storage = multer.memoryStorage(); // Uncommented
const upload = multer({ storage: storage }); // Uncommented

// --- Route Imports ---
const uploadRoutes = require('./routes/uploadRoutes');
const processImageRoutes = require('./routes/processImageRoutes');
const processTextWorkerRoutes = require('./routes/processTextWorkerRoutes');
const urlRoutes = require('./routes/urlRoutes');
const urlJobRoutes = require('./routes/urlJobRoutes');
const jobStatusRoutes = require('./routes/jobStatusRoutes');
const listRoutes = require('./routes/listRoutes');
const instacartRoutes = require('./routes/instacartRoutes');
const airwallexRoutes = require('./routes/airwallexRoutes');

// --- API Routes ---
app.use('/api/upload', uploadRoutes);
app.use('/api/process-image', processImageRoutes);
app.use('/api/process-text-worker', processTextWorkerRoutes);
app.use('/api/process-url', urlRoutes);
app.use('/api/process-url-job', urlJobRoutes);
app.use('/api/job-status', jobStatusRoutes);
app.use('/api/create-list', listRoutes);
app.use('/api/send-to-instacart', instacartRoutes);

// Direct test route for Airwallex POST (can be removed later)
app.post('/api/airwallex/create-payment-link-test', (req, res) => {
  console.log('--- /api/airwallex/create-payment-link-test route hit ---');
  console.log('Request body:', req.body);
  res.status(200).json({ message: 'Test route for POST was successful' });
});

app.use('/api/airwallex', airwallexRoutes);

// --- Basic Root Route ---
app.get('/', (req, res) => {
    res.send('Recipe-to-Cart Backend is running!'); // Restored original message
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`); // Restored original message
    if (!isVercel) {
        console.log(`Local development mode active.`);
    }
});

// Export the app for Vercel
module.exports = app;