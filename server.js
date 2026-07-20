const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors'); 
const http = require('http'); 
const { Server } = require('socket.io');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app); 

// --- 1. SOCKET.IO CONFIGURATION ---
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST", "PATCH", "DELETE"]
    }
});

// --- DATABASE CONFIGURATION (NEON VERSION) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,  
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.connect((err, client, release) => {
    if (err) return console.error('Error connecting to database:', err.stack);
    console.log('Successfully connected to Neon PostgreSQL!');
    release();
});

// --- EMAIL CONFIGURATION ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'haysherry30@gmail.com',
        pass: process.env.EMAIL_PASS || 'ueym uihi aduq frzp' // Recommended na ilagay sa env variable
    }
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
        let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        let userFound = result.rows[0];
        let isAdmin = false;

        if (!userFound) {
            result = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
            userFound = result.rows[0];
            if (userFound) isAdmin = true;
        }

        if (userFound) {
            let isMatch = false;
            if (isAdmin) {
                isMatch = (password === userFound.password);
            } else {
                isMatch = await bcrypt.compare(password, userFound.password);
            }

            if (isMatch) {
                res.status(200).json({ 
                    message: "Login successful", 
                    user: {
                        id: userFound.id,
                        fullname: userFound.full_name || userFound.fullname,
                        role: userFound.role || 'user',
                        email: userFound.email
                    } 
                });
            } else {
                res.status(401).json({ error: "Invalid credentials!" });
            }
        } else {
            res.status(401).json({ error: "Invalid credentials!" });
        }
    } catch (err) { 
        console.error("Login Error:", err);
        res.status(500).json({ error: "Server Error" }); 
    }
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
        
        // Notify admin panel & trigger student progress refresh
        io.emit('newApplication'); 
        if (data.user_id) {
            io.emit('application_status_updated', { userId: data.user_id, status: 'Pending' });
        }

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
        const result = await pool.query("SELECT id, user_id, first_name, last_name, mobile_number, email, gcash, program_type, status FROM submitted_programs WHERE status = 'Approved' ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching approved list" }); }
});

app.get('/applications/rejected', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, user_id, first_name, last_name, program_type, status FROM submitted_programs WHERE status = 'Rejected' ORDER BY submitted_at DESC");
        res.status(200).json(result.rows);
    } catch (err) { res.status(500).json({ error: "Error fetching rejected list" }); }
});

app.patch('/applications/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const result = await pool.query(
            'UPDATE submitted_programs SET status = $1 WHERE id = $2 RETURNING user_id, program_type, first_name, email', 
            [status, id]
        );
        
        if (result.rows.length > 0) {
            const applicant = result.rows[0];
            const notificationMsg = `Ang iyong application (#${id}) para sa ${applicant.program_type} ay ${status}.`;

            await pool.query(
                'INSERT INTO notifications (user_id, message, status, created_at) VALUES ($1, $2, $3, NOW())', 
                [applicant.user_id, notificationMsg, 'unread']
            );
            
            // Real-time socket emit para sa student tracker
            io.emit('application_status_updated', { 
                userId: applicant.user_id, 
                status: status 
            });

            const mailOptions = {
                from: '"TUGON PH" <haysherry30@gmail.com>', 
                to: applicant.email,
                subject: `Application Status: ${status}`,
                text: `Good Day!, ${applicant.first_name}!\n\nYour Application for ${applicant.program_type} is ${status}.\n\nThank You!\n- Tugon Team`
            };

            transporter.sendMail(mailOptions, (error, info) => {
                if (error) console.log('Email Error:', error);
                else console.log('Email sent: ' + info.response);
            });
            
            res.status(200).json({ message: "Updated and Notification sent!", data: applicant });
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

// --- 9. PAYOUT NOTIFICATION ---
app.post('/notify-payout', async (req, res) => {
    const { email, firstName, lastName, applicationId, userId } = req.body;

    try {
        // 1. Update Application Status sa DB kung may ibinigay na applicationId
        if (applicationId) {
            await pool.query(
                "UPDATE submitted_programs SET status = 'Payout Completed' WHERE id = $1",
                [applicationId]
            );
        }

        // 2. Real-time Socket Trigger para mag-update ang timeline ng student
        if (userId) {
            io.emit('application_status_updated', { 
                userId: userId, 
                status: 'Payout Completed' 
            });
        }

        // 3. Email Notification
        const mailOptions = {
            from: '"TUGON PH" <haysherry30@gmail.com>',
            to: email,
            subject: 'PAYOUT CONFIRMED - TUGON System',
            html: `
                <div style="font-family: Arial, sans-serif; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
                    <h2 style="color: #7a0000;">PAYOUT SUCCESSFUL!</h2>
                    <p>Hello <b>${firstName} ${lastName}</b>,</p>
                    <p>Good news! This is to confirm that your financial assistance from the TUGON portal has been successfully processed and sent to your <b>GCash number</b>.</p>
                    <p>Please check your GCash wallet to verify the receipt of your funds.</p>
                    <hr>
                    <p style="font-size: 0.8rem; color: #888;">This is an automated notification. No need to reply.</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        res.status(200).json({ message: 'Payout email sent and status updated successfully!' });
    } catch (error) {
        console.error('Error sending payout email:', error);
        res.status(500).json({ error: 'Failed to process payout notification' });
    }
});

// --- 10. USER DASHBOARD STATS ROUTE ---
app.get('/api/user/dashboard-stats', async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    try {
        const activeAppsQuery = `
            SELECT COUNT(*) AS active_count 
            FROM submitted_programs 
            WHERE user_id = $1 AND status IN ('Pending', 'Under Review')
        `;

        const latestStatusQuery = `
            SELECT status 
            FROM submitted_programs 
            WHERE user_id = $1 
            ORDER BY submitted_at DESC 
            LIMIT 1
        `;

        const verifiedDocsQuery = `
            SELECT 
                (CASE WHEN doc_coe IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_psa IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_school_id IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_billing IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_med_cert IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_social_case IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_patient_id IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_rep_id IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_gov_id IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_indigency IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_form IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN photo_2x2 IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN doc_patient_photo IS NOT NULL THEN 1 ELSE 0 END) AS doc_count
            FROM submitted_programs
            WHERE user_id = $1
            ORDER BY submitted_at DESC
            LIMIT 1
        `;

        const totalGrantsQuery = `
            SELECT COUNT(*) AS grants_count 
            FROM submitted_programs 
            WHERE user_id = $1 AND status IN ('Approved', 'Payout Completed')
        `;

        const [activeRes, statusRes, docsRes, grantsRes] = await Promise.all([
            pool.query(activeAppsQuery, [userId]),
            pool.query(latestStatusQuery, [userId]),
            pool.query(verifiedDocsQuery, [userId]),
            pool.query(totalGrantsQuery, [userId])
        ]);

        const activeApps = parseInt(activeRes.rows[0]?.active_count || 0);
        const verifiedDocs = parseInt(docsRes.rows[0]?.doc_count || 0);
        const totalGrants = parseInt(grantsRes.rows[0]?.grants_count || 0);
        const overallStatus = statusRes.rows[0]?.status || 'No Application';

        res.status(200).json({
            success: true,
            stats: {
                activeApplications: activeApps,
                verifiedDocuments: verifiedDocs,
                totalGrants: totalGrants,
                overallStatus: overallStatus
            }
        });

    } catch (err) {
        console.error("Error fetching user stats:", err.message);
        res.status(500).json({ error: "Failed to fetch dashboard stats" });
    }
});

// --- SERVER START ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => { 
    console.log(`Server running on port ${PORT}`); 
});
