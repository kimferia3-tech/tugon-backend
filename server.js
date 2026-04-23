const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors'); 
const http = require('http'); 
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app); 

// --- 1. SOCKET.IO CONFIGURATION ---
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "PATCH", "DELETE"],
        credentials: true
    }
});

const pool = new Pool({
    connectionString: 'postgresql://tugondb_user:dlVoDAJvrcccEseW7BujbPdhJtqq96Lz@dpg-d7fq3hf7f7vs73a7s5a0-a/tugondb',  
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) return console.error('Error connecting to database:', err.stack);
    console.log('Successfully connected to Render PostgreSQL!');
    release();
});

// --- 2. MULTER CONFIG ---
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- 3. MIDDLEWARES ---
app.use(cors()); 
app.use(express.json());
app.use(express.static(__dirname)); 
app.use('/uploads', express.static('uploads'));

// --- 4. SOCKET.IO CHAT LOGIC ---
let activeUsers = new Set();
io.on('connection', (socket) => {
    socket.on('join_chat', (data) => {
        if (data.room) {
            socket.join(data.room);
            if (data.room !== 'Admin' && data.room !== 'General') {
                activeUsers.add(data.room);
                io.emit('update_user_list', Array.from(activeUsers));
            }
        }
    });

    socket.on('get_chat_history', async (data) => {
        try {
            const result = await pool.query(
                "SELECT sender, message as text, TO_CHAR(created_at, 'HH12:MI AM') as time FROM chat_messages WHERE room = $1 ORDER BY created_at ASC",
                [data.room]
            );
            socket.emit('chat_history', result.rows);
        } catch (err) { console.error("Error loading history:", err); }
    });

    socket.on('send_message', async (data) => {
        try {
            await pool.query('INSERT INTO chat_messages (sender, message, room) VALUES ($1, $2, $3)', [data.sender, data.text, data.room]);
            const realTime = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
            io.to(data.room).emit('receive_message', { text: data.text, sender: data.sender, time: realTime, room: data.room });
        } catch (err) { console.error("Error saving message:", err); }
    });

    socket.on('typing', (data) => { socket.to(data.room).emit('display_typing', data); });
});

// --- 5. AUTHENTICATION ROUTES ---
app.post('/signup', async (req, res) => {
    const { fullname, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query('INSERT INTO users(fullname, email, password) VALUES($1, $2, $3) RETURNING *', [fullname, email, hashedPassword]);
        res.status(200).json({ message: "User registered!", user: result.rows[0] });
    } catch (err) { res.status(500).json({ error: "Database error!" }); }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) res.status(200).json({ message: "Login successful", user: user });
            else res.status(401).json({ error: "Invalid credentials!" });
        } else res.status(401).json({ error: "Invalid credentials!" });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

// --- 6. PROGRAM SUBMISSION ---
app.post('/submit-program', upload.fields([
    { name: 'doc_coe', maxCount: 1 },
    { name: 'doc_indigency', maxCount: 1 },
    { name: 'doc_school_id', maxCount: 1 },
    { name: 'doc_gov_id', maxCount: 1 }
]), async (req, res) => {
    const data = req.body;
    const files = req.files;
    try {
        const queryText = `
            INSERT INTO submitted_programs (
                user_id, program_type, application_role, first_name, middle_name, last_name, 
                dob, age, civil_status, sex, street, barangay, municipality, province, 
                mobile_number, email, gcash, school_name, year_level, course, 
                doc_coe, doc_indigency, doc_school_id, doc_gov_id, status, submitted_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW())`;

        const values = [
            data.user_id || null, data.program_type, data.application_role, data.first_name, data.middle_name, data.last_name, 
            data.dob, data.age, data.civil_status, data.sex, data.street, data.barangay, data.municipality, data.province, 
            data.mobile_number, data.email, data.gcash, data.school_name, data.year_level, data.course,
            files['doc_coe'] ? files['doc_coe'][0].filename : null,
            files['doc_indigency'] ? files['doc_indigency'][0].filename : null,
            files['doc_school_id'] ? files['doc_school_id'][0].filename : null,
            files['doc_gov_id'] ? files['doc_gov_id'][0].filename : null,
            data.status || 'Pending'
        ];

        await pool.query(queryText, values);
        await pool.query('INSERT INTO notifications (message, status, created_at) VALUES ($1, $2, NOW())', [`${data.first_name} applied for ${data.program_type}.`, 'unread']);
        res.status(200).json({ message: "Application submitted!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 7. ADMIN & USER DATA ROUTES ---
app.get('/applications', async (req, res) => {
    try {
        const result = await pool.query("SELECT *, TO_CHAR(submitted_at, 'Mon DD, YYYY') as date FROM submitted_programs ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching applications" }); }
});

app.patch('/applications/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        await pool.query('UPDATE submitted_programs SET status = $1 WHERE id = $2', [status, id]);
        res.status(200).json({ message: "Status updated!" });
    } catch (err) { res.status(500).json({ error: "Failed update" }); }
});

app.get('/notifications', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error" }); }
});

const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
