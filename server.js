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

// ================= SOCKET.IO =================
const io = new Server(server, {
    cors: {
        origin: [
            "https://www.tugonph.com",
            "https://tugonph.com",
            "http://localhost:3000",
            "http://127.0.0.1:5500"
        ],
        methods: ["GET", "POST", "PATCH", "DELETE"],
        credentials: true
    }
});

// ================= DATABASE =================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('Database connection error:', err.stack);
    } else {
        console.log('Successfully connected to PostgreSQL!');
        release();
    }
});

// ================= MULTER =================
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// ================= MIDDLEWARE =================
app.use(cors({
    origin: [
        "https://www.tugonph.com",
        "https://tugonph.com",
        "http://localhost:3000",
        "http://127.0.0.1:5500"
    ],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static('uploads'));

// ================= SOCKET CHAT =================
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
                `SELECT sender, message as text,
                 TO_CHAR(created_at, 'HH12:MI AM') as time
                 FROM chat_messages
                 WHERE room = $1
                 ORDER BY created_at ASC`,
                [data.room]
            );

            socket.emit('chat_history', result.rows);
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('send_message', async (data) => {
        try {
            await pool.query(
                'INSERT INTO chat_messages (sender, message, room) VALUES ($1, $2, $3)',
                [data.sender, data.text, data.room]
            );

            const time = new Date().toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });

            io.to(data.room).emit('receive_message', {
                text: data.text,
                sender: data.sender,
                time,
                room: data.room
            });

        } catch (err) {
            console.error(err);
        }
    });

    socket.on('typing', (data) => {
        socket.to(data.room).emit('display_typing', data);
    });
});

// ================= AUTH =================
app.post('/signup', async (req, res) => {
    const { fullname, email, password } = req.body;

    try {
        const existing = await pool.query(
            'SELECT * FROM users WHERE email=$1',
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'INSERT INTO users(fullname, email, password) VALUES($1, $2, $3) RETURNING id, fullname, email',
            [fullname, email, hashedPassword]
        );

        res.status(200).json({
            message: "User registered!",
            user: result.rows[0]
        });

    } catch (err) {
        res.status(500).json({ error: "Database error!" });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email=$1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const { password: _, ...safeUser } = user;

        res.status(200).json({
            message: "Login successful",
            user: safeUser
        });

    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// ================= SUBMIT PROGRAM =================
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

    const file = (name) =>
        req.files && req.files[name]
            ? req.files[name][0].filename
            : null;

    try {
        const query = `
        INSERT INTO submitted_programs (
            user_id, program_type, application_role,
            first_name, middle_name, last_name,
            dob, age, civil_status, sex,
            street, barangay, municipality, province,
            mobile_number, email, gcash,
            school_name, year_level, course,
            father_name, mother_name, father_occ, mother_occ,
            doc_coe, doc_psa, doc_school_id, doc_billing,
            doc_med_cert, doc_case_study, doc_patient_id,
            doc_rep_id, doc_gov_id, doc_indigency, doc_form,
            photo_2x2, doc_patient_photo, status
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
            $31,$32,$33,$34,$35,$36,$37,$38
        )
        RETURNING *`;

        const values = [
            data.user_id || null,
            data.program_type,
            data.application_role || 'N/A',
            data.first_name,
            data.middle_name || '',
            data.last_name,
            data.dob || null,
            data.age ? parseInt(data.age) : null,
            data.civil_status,
            data.sex,
            data.street,
            data.barangay,
            data.municipality,
            data.province,
            data.mobile_number,
            data.email,
            data.gcash || 'N/A',
            data.school_name || 'N/A',
            data.year_level || 'N/A',
            data.course || 'N/A',
            data.father_name || 'N/A',
            data.mother_name || 'N/A',
            data.father_occ || 'N/A',
            data.mother_occ || 'N/A',

            file('doc_coe'),
            file('doc_psa'),
            file('doc_school_id'),
            file('doc_billing'),
            file('doc_med_cert'),
            file('doc_case_study'),
            file('doc_patient_id'),
            file('doc_rep_id'),
            file('doc_gov_id'),
            file('doc_indigency'),
            file('doc_form'),
            file('id_photo_2x2'),
            file('doc_patient_photo'),

            'Pending'
        ];

        const result = await pool.query(query, values);

        // REALTIME UPDATE FIX
        io.emit('newApplication', result.rows[0]);

        res.status(200).json({
            message: "Success",
            application: result.rows[0]
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ================= ADMIN =================
app.get('/applications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *,
            TO_CHAR(submitted_at, 'Mon DD, YYYY') as date
            FROM submitted_programs
            ORDER BY submitted_at DESC
        `);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Error" });
    }
});

app.patch('/applications/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    try {
        const result = await pool.query(
            'UPDATE submitted_programs SET status=$1 WHERE id=$2 RETURNING *',
            [status, id]
        );

        if (result.rows.length > 0) {

            // REALTIME FIX
            io.emit('applicationUpdated', result.rows[0]);

            res.json({
                message: "Updated",
                data: result.rows[0]
            });
        } else {
            res.status(404).json({ error: "Not found" });
        }

    } catch (err) {
        res.status(500).json({ error: "Failed" });
    }
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
