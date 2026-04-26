const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors'); 
const http = require('http'); 
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const app = express();
const server = http.createServer(app); 

// --- 1. SOCKET.IO CONFIGURATION ---
const io = new Server(server, {
    cors: { 
        origin: ["https://www.tugonph.com", "https://tugonph.com"], 
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
app.use(cors({ 
    origin: ["https://www.tugonph.com", "https://tugonph.com"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true 
})); 
app.use(express.json());
app.use(express.static(__dirname)); 
app.use('/uploads', express.static('uploads'));

// --- 4. SOCKET.IO CHAT LOGIC ---
let activeUsers = new Set();

io.on('connection', (socket) => {
    socket.on('join_chat', async (data) => {
        if (data.room) {
            socket.join(data.room);
            if (data.room !== 'Admin' && data.room !== 'General') {
                activeUsers.add(data.room);
                io.emit('update_user_list', Array.from(activeUsers));
            }
        }
    });

    socket.on('request_user_list', () => {
        socket.emit('update_user_list', Array.from(activeUsers));
    });

    socket.on('get_chat_history', async (data) => {
        try {
            const result = await pool.query(
                "SELECT sender, message as text, TO_CHAR(created_at, 'HH12:MI AM') as time FROM chat_messages WHERE room = $1 ORDER BY created_at ASC",
                [data.room]
            );
            socket.emit('chat_history', result.rows);
        } catch (err) { 
            console.error("Error fetching history:", err); 
        }
    });

    socket.on('send_message', async (data) => {
        try {
            await pool.query(
                'INSERT INTO chat_messages (sender, message, room, created_at) VALUES ($1, $2, $3, NOW())', 
                [data.sender, data.text, data.room]
            );

            const realTime = new Date().toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit', 
                hour12: true 
            });

            io.to(data.room).emit('receive_message', { 
                text: data.text, 
                sender: data.sender, 
                time: realTime, 
                room: data.room 
            });
        } catch (err) { 
            console.error("Error saving/sending msg:", err); 
        }
    });

    socket.on('typing', (data) => { 
        socket.to(data.room).emit('display_typing', data); 
    });

    socket.on('disconnect', () => {});
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
            const isMatch = await bcrypt.compare(password, result.rows[0].password);
            if (isMatch) res.status(200).json({ message: "Login successful", user: result.rows[0] });
            else res.status(401).json({ error: "Invalid credentials!" });
        } else res.status(401).json({ error: "Invalid credentials!" });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

// --- 6. SUBMIT PROGRAM LOGIC ---
app.post('/submit-program', upload.fields([
    { name: 'id_photo_2x2', maxCount: 1 }, 
    { name: 'doc_coe', maxCount: 1 },
    { name: 'doc_psa', maxCount: 1 }, 
    { name: 'doc_school_id', maxCount: 1 },
    { name: 'doc_form', maxCount: 1 }, 
    { name: 'doc_billing', maxCount: 1 },
    { name: 'doc_med_cert', maxCount: 1 }, 
    { name: 'doc_case_study', maxCount: 1 }, 
    { name: 'doc_patient_id', maxCount: 1 }, 
    { name: 'doc_rep_id', maxCount: 1 },
    { name: 'doc_gov_id', maxCount: 1 }, 
    { name: 'doc_indigency', maxCount: 1 },
    { name: 'doc_patient_photo', maxCount: 1 }
]), async (req, res) => {
    const data = req.body;
    const getFileName = (fieldName) => (req.files && req.files[fieldName]) ? req.files[fieldName][0].filename : null;

    try {
        const queryText = `
            INSERT INTO submitted_programs (
                user_id, program_type, application_role, first_name, middle_name, last_name, 
                dob, age, civil_status, sex, street, barangay, municipality, province, 
                mobile_number, email, gcash, school_name, year_level, course,
                father_name, mother_name, father_occ, mother_occ,
                doc_coe, doc_psa, doc_school_id, doc_billing, doc_med_cert, 
                doc_social_case, doc_patient_id, doc_rep_id, doc_gov_id, doc_indigency, doc_form,
                photo_2x2, doc_patient_photo, status
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38
            ) RETURNING *`;

        const values = [
            data.user_id || null, data.program_type, data.application_role || 'N/A', data.first_name, data.middle_name || '', data.last_name, 
            data.dob || null, data.age ? parseInt(data.age) : null, data.civil_status, data.sex, data.street, data.barangay, data.municipality, data.province, 
            data.mobile_number, data.email, data.gcash || 'N/A', data.school_name || 'N/A', data.year_level || 'N/A', data.course || 'N/A',
            data.father_name || 'N/A', data.mother_name || 'N/A', data.father_occ || 'N/A', data.mother_occ || 'N/A',
            getFileName('doc_coe'), getFileName('doc_psa'), getFileName('doc_school_id'), getFileName('doc_billing'), getFileName('doc_med_cert'),
            getFileName('doc_case_study'), getFileName('doc_patient_id'), getFileName('doc_rep_id'), getFileName('doc_gov_id'), getFileName('doc_indigency'), getFileName('doc_form'),
            getFileName('id_photo_2x2'), getFileName('doc_patient_photo'), 
            'Pending'
        ];

        const result = await pool.query(queryText, values);
        io.emit('newApplication'); 
        res.status(200).json({ message: "Success", application: result.rows[0] });
    } catch (err) {
        console.error("DETALYE NG ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- 7. ADMIN ROUTES ---

app.get('/applications', async (req, res) => {
    try {
        const result = await pool.query("SELECT *, TO_CHAR(submitted_at, 'Mon DD, YYYY') as date FROM submitted_programs ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error" }); }
});

app.get('/applications/approved', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, first_name, last_name, mobile_number, gcash, status FROM submitted_programs WHERE status = 'Approved' ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching approved list" }); }
});

app.get('/applications/rejected', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, first_name, last_name, program_type, status FROM submitted_programs WHERE status = 'Rejected' ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching rejected list" }); }
});

app.patch('/applications/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query(
            'UPDATE submitted_programs SET status = $1 WHERE id = $2 RETURNING user_id, program_type, first_name, mobile_number', 
            [status, id]
        );
        
        if (result.rows.length > 0) {
            const applicant = result.rows[0];
            const notificationMsg = `Application #${id} for ${applicant.program_type} is now ${status}.`;

            await pool.query(
                'INSERT INTO notifications (user_id, message, status, created_at) VALUES ($1, $2, $3, NOW())', 
                [applicant.user_id, notificationMsg, 'unread']
            );
            
            // SMS FUNCTION REMOVED TO PREVENT RENDER ERRORS DURING DEMO
            
            res.status(200).json({ message: "Updated and Notification saved!", data: applicant });
        } else {
            res.status(404).json({ error: "Not found" });
        }
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: "Failed to update and notify" }); 
    }
});

app.get('/api/notifications/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const result = await pool.query(
            'SELECT *, TO_CHAR(created_at, \'Mon DD, HH:MI AM\') as time FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', 
            [userId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Error fetching notifications" });
    }
});

// --- 8. PROGRAM DISPATCHER LOGIC ---

app.post('/api/programs', async (req, res) => {
    const { title, slots, launchDate } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO programs (title, slots, launch_date) VALUES ($1, $2, $3) RETURNING *',
            [title, slots, launchDate]
        );
        io.emit('new_program_published', result.rows[0]); 
        res.status(200).json({ message: "Program Published!", program: result.rows[0] });
    } catch (err) {
        console.error("Error publishing program:", err.message);
        res.status(500).json({ error: "Failed to publish program" });
    }
});

app.get('/api/programs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM programs ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Error fetching programs" });
    }
});

const PORT = process.env.PORT || 10000; 
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
