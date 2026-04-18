const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors'); 
const http = require('http'); 
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs'); // <--- ITO LANG ANG NADAGDAG SA TAAS

const app = express();
const server = http.createServer(app); 
const io = new Server(server, {
    cors: { 
        origin: "https://www.tugonph.com", 
        methods: ["GET", "POST"]
    }
});

// --- 1. DATABASE CONFIGURATION ---
const pool = new Pool({
    connectionString: 'postgres://admin:YvYg6LhUo0Wky56L423377S9Dq2W6697@dpg-cvf8gtt6147c739b6990-a.singapore-postgres.render.com/tugon_db',
    ssl: {
        rejectUnauthorized: false 
    },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Mas maayos na error handling para sa connection
pool.on('error', (err) => {
    console.error('Unexpected error on idle database client', err);
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Error connecting to database:', err.stack);
    }
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
app.use(cors({ origin: "https://www.tugonph.com" })); 
app.use(express.json());
app.use(express.static(__dirname)); 
app.use('/uploads', express.static('uploads'));

// --- 4. SOCKET.IO CHAT LOGIC (WALANG BINAGO RITO) ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('get_chat_history', async () => {
        try {
            const result = await pool.query(
                "SELECT sender, message as text, TO_CHAR(created_at, 'HH12:MI AM') as time FROM chat_messages ORDER BY created_at ASC"
            );
            socket.emit('chat_history', result.rows);
        } catch (err) {
            console.error("Error loading history:", err);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            await pool.query(
                'INSERT INTO chat_messages (sender, message) VALUES ($1, $2)', 
                [data.sender, data.text]
            );
            const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            io.emit('receive_message', { 
                text: data.text, 
                sender: data.sender, 
                time: time 
            });
        } catch (err) {
            console.error("Error saving/sending message:", err);
        }
    });

    socket.on('disconnect', () => { console.log('User disconnected'); });
});

// --- 5. AUTHENTICATION ROUTES (ITO LANG ANG IN-UPDATE PARA SA LOGIN BUG) ---
app.post('/signup', async (req, res) => {
    const { fullname, email, password } = req.body;
    try {
        // I-hash ang password bago i-save para safe
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO users(fullname, email, password) VALUES($1, $2, $3) RETURNING *', 
            [fullname, email, hashedPassword] 
        );
        res.status(200).json({ message: "User registered!", user: result.rows[0] });
    } catch (err) { 
        res.status(500).json({ error: "Database error!" }); 
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];
            // I-compare ang plain text password sa hashed password sa DB
            const isMatch = await bcrypt.compare(password, user.password);
            
            if (isMatch) {
                res.status(200).json({ message: "Login successful", user: user });
            } else {
                res.status(401).json({ error: "Invalid credentials!" });
            }
        } else { 
            res.status(401).json({ error: "Invalid credentials!" }); 
        }
    } catch (err) { 
        res.status(500).json({ error: "Server Error" }); 
    }
});

// --- 6. PROGRAM SUBMISSION (WALANG BINAGO RITO) ---
app.post('/submit-program', upload.fields([
    { name: 'doc_coe', maxCount: 1 },
    { name: 'doc_indigency', maxCount: 1 },
    { name: 'doc_school_id', maxCount: 1 },
    { name: 'doc_gov_id', maxCount: 1 }
]), async (req, res) => {
    const { 
        user_id, program_type, application_role, first_name, middle_name, last_name, 
        dob, age, civil_status, sex, street, barangay, municipality, province, 
        mobile_number, email, gcash, school_name, year_level, course, status 
    } = req.body;

    const file_coe = req.files['doc_coe'] ? req.files['doc_coe'][0].filename : null;
    const file_indigency = req.files['doc_indigency'] ? req.files['doc_indigency'][0].filename : null;
    const file_school_id = req.files['doc_school_id'] ? req.files['doc_school_id'][0].filename : null;
    const file_gov_id = req.files['doc_gov_id'] ? req.files['doc_gov_id'][0].filename : null;

    try {
        const queryText = `
            INSERT INTO submitted_programs (
                user_id, program_type, application_role, first_name, middle_name, last_name, 
                dob, age, civil_status, sex, street, barangay, municipality, province, 
                mobile_number, email, gcash, school_name, year_level, course, 
                doc_coe, doc_indigency, doc_school_id, doc_gov_id,
                status, submitted_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW())
            RETURNING *`;

        const values = [
            user_id || null, program_type, application_role, first_name, middle_name, last_name, 
            dob, age, civil_status, sex, street, barangay, municipality, province, 
            mobile_number, email, gcash, school_name, year_level, course,
            file_coe, file_indigency, file_school_id, file_gov_id,
            status || 'Pending'
        ];

        const result = await pool.query(queryText, values);
        
        await pool.query(
            'INSERT INTO notifications (message, status, created_at) VALUES ($1, $2, NOW())',
            [`${first_name} applied for ${program_type}.`, 'unread']
        );
        
        res.status(200).json({ message: "Application submitted!", application: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to save: " + err.message });
    }
});

// --- 7. ADMIN & USER DATA ROUTES (WALANG BINAGO RITO) ---
app.get('/applications', async (req, res) => {
    try {
        const result = await pool.query("SELECT *, TO_CHAR(submitted_at, 'Mon DD, YYYY') as date FROM submitted_programs ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching applications" }); }
});

app.get('/student/my-applications', async (req, res) => {
    const { email } = req.query; 
    try {
        const result = await pool.query(
            "SELECT id, program_type, status, TO_CHAR(submitted_at, 'Mon DD, YYYY') as date_applied FROM submitted_programs WHERE email = $1 ORDER BY submitted_at DESC",
            [email]
        );
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching user records" }); }
});

app.post('/update-status', async (req, res) => {
    const { id, status } = req.body;
    try {
        await pool.query('UPDATE submitted_programs SET status = $1 WHERE id = $2', [status, id]);
        await pool.query(
            'INSERT INTO notifications (message, status, created_at) VALUES ($1, $2, NOW())',
            [`Application #${id} is now ${status}.`, 'unread']
        );
        res.status(200).json({ message: "Status updated!" });
    } catch (err) { res.status(500).json({ error: "Failed update" }); }
});

app.get('/notifications', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM notifications ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error" }); }
});
// --- 8. START SERVER ---
const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
