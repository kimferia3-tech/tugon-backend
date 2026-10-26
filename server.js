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
const fs = require('fs');
// Optional: Cloudinary for permanent file storage on Render
// npm install cloudinary
let cloudinary = null;
try {
    cloudinary = require('cloudinary').v2;
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET
        });
        console.log('Cloudinary configured — uploads will be permanent.');
    } else {
        cloudinary = null;
        console.warn('Cloudinary env vars missing — falling back to local ./uploads (ephemeral on Render).');
    }
} catch (e) {
    console.warn('cloudinary package not installed — using local ./uploads only.');
    cloudinary = null;
}

const app = express();
const server = http.createServer(app);

// --- 1. SOCKET.IO CONFIGURATION ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
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

// Test connection without hanging a pool connection client
pool.query('SELECT NOW()', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.stack);
    } else {
        console.log('Successfully connected to Neon PostgreSQL!');
    }
});

// --- EMAIL CONFIGURATION ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// --- 2. MULTER CONFIG ---
// Ensure local uploads folder exists (fallback / local dev)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Always store on disk first; if Cloudinary is configured we upload then replace with secure URL
const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        cb(
            null,
            file.fieldname + '-' + Date.now() + path.extname(file.originalname)
        );
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

/** Upload one local file to Cloudinary; returns secure_url or local filename */
async function persistFile(localFilename) {
    if (!localFilename) return null;
    const localPath = path.join(UPLOAD_DIR, localFilename);
    if (!cloudinary) {
        // Keep local filename — served via /uploads
        return localFilename;
    }
    try {
        const result = await cloudinary.uploader.upload(localPath, {
            folder: 'tugon-eduassist',
            resource_type: 'auto',
            use_filename: true,
            unique_filename: true
        });
        // Remove local copy after successful cloud upload
        try { fs.unlinkSync(localPath); } catch (_) { }
        return result.secure_url; // full https URL saved in DB
    } catch (err) {
        console.error('Cloudinary upload failed, keeping local file:', err.message);
        return localFilename;
    }
}

// --- 3. MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOAD_DIR));

// =======================================================
// --- 4. SOCKET.IO CHAT LOGIC ---
// =======================================================

const activeUsers = new Map();

io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('join_chat', async (data = {}) => {
        try {
            const room = String(data.room || '').trim();
            if (!room) return;

            socket.join(room);
            socket.data.chatRoom = room;

            if (room !== 'Admin' && room !== 'General') {
                activeUsers.set(room, {
                    socketId: socket.id,
                    online: true
                });
            }

            io.emit('update_user_list', Array.from(activeUsers.keys()));
            socket.emit('chat_connected', { room });
        } catch (err) {
            console.error('join_chat error:', err.message);
        }
    });

    socket.on('request_user_list', () => {
        socket.emit('update_user_list', Array.from(activeUsers.keys()));
    });

    socket.on('get_chat_history', async (data = {}) => {
        try {
            const room = String(data.room || '').trim();
            if (!room) {
                return socket.emit('chat_history', []);
            }

            const result = await pool.query(
                `
                SELECT
                    id,
                    sender,
                    message AS text,
                    room,
                    TO_CHAR(created_at, 'HH12:MI AM') AS time,
                    created_at
                FROM chat_messages
                WHERE room = $1
                ORDER BY created_at ASC
                `,
                [room]
            );

            socket.emit('chat_history', result.rows);
        } catch (err) {
            console.error('Error fetching chat history:', err.message);
            socket.emit('chat_history', []);
        }
    });

    socket.on('send_message', async (data = {}) => {
        try {
            const text = String(data.text || '').trim();
            const sender = String(data.sender || '').trim();
            const room = String(data.room || '').trim();

            if (!text || !sender || !room) return;

            const result = await pool.query(
                `
                INSERT INTO chat_messages (sender, message, room, created_at)
                VALUES ($1, $2, $3, NOW())
                RETURNING
                    id,
                    sender,
                    message AS text,
                    room,
                    TO_CHAR(created_at, 'HH12:MI AM') AS time,
                    created_at
                `,
                [sender, text, room]
            );

            const message = result.rows[0];

            io.to(room).emit('receive_message', message);
            io.to(room).emit('chat_notification', {
                room,
                sender,
                text,
                time: message.time
            });

            if (sender === 'User') {
                io.to('Admin').emit('new_chat_notification', {
                    room,
                    sender,
                    text,
                    time: message.time
                });
            }

            if (sender === 'Admin') {
                io.to(room).emit('new_chat_notification', {
                    room,
                    sender,
                    text,
                    time: message.time
                });
            }
        } catch (err) {
            console.error('Error saving/sending message:', err.message);
        }
    });

    socket.on('typing', (data = {}) => {
        const room = String(data.room || '').trim();
        if (!room) return;
        socket.to(room).emit('display_typing', data);
    });

    socket.on('disconnect', () => {
        for (const [room, info] of activeUsers.entries()) {
            if (info.socketId === socket.id) {
                activeUsers.delete(room);
                break;
            }
        }
        io.emit('update_user_list', Array.from(activeUsers.keys()));
        console.log('Socket disconnected:', socket.id);
    });
});

// =======================================================
// --- 5. AUTHENTICATION ROUTES ---
// =======================================================

app.post('/signup', async (req, res) => {
    const { fullname, email, password } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `
            INSERT INTO users (fullname, email, password)
            VALUES ($1, $2, $3)
            RETURNING *
            `,
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

            try {
                isMatch = await bcrypt.compare(password, userFound.password);
            } catch (bErr) {
                isMatch = password === userFound.password;
            }

            if (!isMatch && password === userFound.password) {
                isMatch = true;
            }

            if (isMatch) {
                res.status(200).json({
                    message: "Login successful",
                    user: {
                        id: userFound.id,
                        fullname: userFound.full_name || userFound.fullname,
                        role: isAdmin
                            ? 'admin'
                            : (userFound.role ? userFound.role.toLowerCase() : 'user'),
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

// =======================================================
// --- 6. APPLICATIONS / SUBMITTED PROGRAMS ---
// =======================================================
// =======================================================
// --- GET CURRENT USER (/api/me) ---
// =======================================================
app.get('/api/me', async (req, res) => {
    try {
        const userId = String(req.query.userId || '').trim();
        const email = String(req.query.email || '').trim().toLowerCase();

        if (!userId && !email) {
            return res.status(400).json({ error: 'userId or email required' });
        }

        let result;

        // Try users table first
        if (userId) {
            result = await pool.query(
                `SELECT id, fullname, email, role FROM users WHERE id::text = $1`,
                [userId]
            );
        } else {
            result = await pool.query(
                `SELECT id, fullname, email, role FROM users WHERE LOWER(TRIM(email)) = $1`,
                [email]
            );
        }

        // Fallback to admins table
        if (result.rows.length === 0) {
            if (userId) {
                result = await pool.query(
                    `SELECT id, full_name AS fullname, email, 'admin' AS role FROM admins WHERE id::text = $1`,
                    [userId]
                );
            } else {
                result = await pool.query(
                    `SELECT id, full_name AS fullname, email, 'admin' AS role FROM admins WHERE LOWER(TRIM(email)) = $1`,
                    [email]
                );
            }
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = result.rows[0];
        res.status(200).json({
            id: user.id,
            fullname: user.fullname,
            email: user.email,
            role: user.role || 'user'
        });
    } catch (err) {
        console.error('/api/me error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});
app.get('/applications', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *,
            TO_CHAR(submitted_at, 'Mon DD, YYYY') AS date
            FROM submitted_programs
            ORDER BY id DESC
            `
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Error fetching submitted_programs:", err.message);
        res.status(500).json({ error: "Error fetching applications" });
    }
});

app.get('/api/applications', async (req, res) => {
    try {
        const email = String(req.query.email || '').trim().toLowerCase();
        let result;
        if (email) {
            result = await pool.query(
                `
                SELECT *,
                TO_CHAR(submitted_at, 'Mon DD, YYYY') AS date
                FROM submitted_programs
                WHERE LOWER(TRIM(email)) = $1
                ORDER BY id DESC
                `,
                [email]
            );
        } else {
            result = await pool.query(
                `
                SELECT *,
                TO_CHAR(submitted_at, 'Mon DD, YYYY') AS date
                FROM submitted_programs
                ORDER BY id DESC
                `
            );
        }
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('GET /api/applications error:', err.message);
        res.status(500).json({ error: 'Error fetching applications' });
    }
});

app.get('/api/applications/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const result = await pool.query(
            `
            SELECT *,
            TO_CHAR(submitted_at, 'Mon DD, YYYY') AS date
            FROM submitted_programs
            WHERE user_id::text = $1
            ORDER BY id DESC
            `,
            [String(userId)]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('GET /api/applications/user error:', err.message);
        res.status(500).json({ error: 'Error fetching user applications' });
    }
});

app.get('/api/notifications/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const result = await pool.query(
            `
            SELECT
                id,
                status,
                program_type,
                submitted_at AS created_at,
                CONCAT('Application status: ', status) AS message,
                CONCAT('Application ', status) AS title
            FROM submitted_programs
            WHERE user_id::text = $1
            ORDER BY id DESC
            LIMIT 20
            `,
            [String(userId)]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('GET /api/notifications error:', err.message);
        res.status(200).json([]);
    }
});

app.put('/applications/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    const allowedStatuses = ['Pending', 'Approved', 'Rejected'];

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid application status' });
    }

    try {
        let result;
        try {
            result = await pool.query(
                `
                UPDATE submitted_programs
                SET status = $1,
                    rejection_reason = CASE
                        WHEN $1 = 'Rejected' THEN COALESCE($3, rejection_reason)
                        ELSE rejection_reason
                    END
                WHERE id = $2
                RETURNING *
                `,
                [status, id, rejectionReason || null]
            );
        } catch (colErr) {
            result = await pool.query(
                `
                UPDATE submitted_programs
                SET status = $1
                WHERE id = $2
                RETURNING *
                `,
                [status, id]
            );
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }

        const updatedApplication = result.rows[0];

        io.emit('applicationStatusUpdated', updatedApplication);
        io.emit('application_updated', updatedApplication);
        io.emit('application_status_updated', {
            userId: updatedApplication.user_id,
            applicationId: updatedApplication.id,
            status: updatedApplication.status
        });

        const applicantEmail = updatedApplication.email;
        if (applicantEmail && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const subject =
                status === 'Approved'
                    ? 'Tugon EduAssist — Application Approved'
                    : status === 'Rejected'
                        ? 'Tugon EduAssist — Application Update'
                        : `Tugon EduAssist — Status: ${status}`;

            const body =
                status === 'Approved'
                    ? `Hello ${updatedApplication.first_name || ''},\n\nYour Educational Assistance application has been APPROVED.\n\nPlease check your Tugon dashboard for next steps.\n\n— Tugon EduAssist Team`
                    : status === 'Rejected'
                        ? `Hello ${updatedApplication.first_name || ''},\n\nYour application status is now: Rejected.\n${rejectionReason ? 'Reason: ' + rejectionReason + '\n' : ''}\nPlease check your dashboard or contact the office for assistance.\n\n— Tugon EduAssist Team`
                        : `Hello ${updatedApplication.first_name || ''},\n\nYour application status is now: ${status}.\n\n— Tugon EduAssist Team`;

            transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: applicantEmail,
                subject,
                text: body
            }).then(() => {
                console.log('Status email sent to', applicantEmail);
            }).catch(mailErr => {
                console.warn('Status email failed:', mailErr.message);
            });
        }

        res.status(200).json({
            message: 'Application status updated successfully',
            application: updatedApplication
        });
    } catch (err) {
        console.error('Error updating application status:', err.message);
        res.status(500).json({ error: 'Failed to update application status' });
    }
});

app.post('/applications', async (req, res) => {
    const { fullName, full_name, municipality, barangay, program, phone } = req.body;
    const applicantName = fullName || full_name;

    try {
        const queryText = `
            INSERT INTO new_applications (full_name, municipality, barangay, program, phone, status)
            VALUES ($1, $2, $3, $4, $5, 'Pending')
            RETURNING *;
        `;
        const values = [applicantName, municipality, barangay, program, phone];
        const result = await pool.query(queryText, values);

        io.emit('newApplication', result.rows[0]);

        res.status(200).json({
            message: "Applicant registered successfully!",
            application: result.rows[0]
        });
    } catch (err) {
        console.error("Error inserting into new_applications:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/debug/database', async (req, res) => {
    try {
        const db = await pool.query(
            `SELECT current_database() AS database_name, current_user AS database_user`
        );
        const count = await pool.query(
            `SELECT COUNT(*) AS total FROM submitted_programs`
        );

        res.json({
            database: db.rows[0],
            submitted_programs_total: count.rows[0].total
        });
    } catch (err) {
        console.error("DATABASE DEBUG ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// =======================================================
// --- 7. NEW SETTINGS & ADMIN PROFILE ---
// =======================================================

app.get('/api/settings', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM new_settings WHERE id = 1");
        res.status(200).json(result.rows[0] || {});
    } catch (err) {
        console.error("Error fetching settings:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    const { standardAmount, totalFunds, autoApproval, emailNotifications } = req.body;

    try {
        const queryText = `
            UPDATE new_settings
            SET
                standard_amount = $1,
                total_funds = $2,
                auto_approval = $3,
                email_notifications = $4
            WHERE id = 1
            RETURNING *;
        `;
        const values = [
            standardAmount || 3000.00,
            totalFunds || 150000.00,
            autoApproval || 'Disabled',
            emailNotifications || 'Enabled'
        ];

        const result = await pool.query(queryText, values);
        res.status(200).json({
            message: "Settings updated successfully!",
            settings: result.rows[0]
        });
    } catch (err) {
        console.error("Error updating settings:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/profile', async (req, res) => {
    const { name, role } = req.body;

    try {
        const queryText = `
            UPDATE new_settings
            SET director_name = $1, role_title = $2
            WHERE id = 1
            RETURNING *;
        `;
        const result = await pool.query(queryText, [name, role]);

        res.status(200).json({
            message: "Admin profile updated successfully!",
            profile: result.rows[0]
        });
    } catch (err) {
        console.error("Error updating admin profile:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// =======================================================
// --- 8. NEW WEBINARS ENDPOINTS ---
// =======================================================

app.get('/api/webinars', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *,
            TO_CHAR(schedule_date, 'Mon DD, YYYY HH:MI AM') AS date_formatted
            FROM new_webinars
            ORDER BY schedule_date ASC
            `
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Error fetching webinars:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/webinars', async (req, res) => {
    const { title, description, schedule_date } = req.body;

    try {
        const queryText = `
            INSERT INTO new_webinars (title, description, schedule_date)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const result = await pool.query(queryText, [
            title,
            description,
            schedule_date || new Date()
        ]);

        res.status(200).json({
            message: "Webinar created successfully!",
            webinar: result.rows[0]
        });
    } catch (err) {
        console.error("Error creating webinar:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// =======================================================
// --- 9. SUBMIT PROGRAM (WITH FULL/FALLBACK STRATEGY) ---
// =======================================================

app.post(
    '/submit-program',
    upload.fields([
        { name: 'photo_2x2', maxCount: 1 },
        { name: 'id_photo_2x2', maxCount: 1 },
        { name: 'doc_coe', maxCount: 1 },
        { name: 'doc_psa', maxCount: 1 },
        { name: 'doc_report_card', maxCount: 1 },
        { name: 'doc_school_id', maxCount: 1 },
        { name: 'doc_form', maxCount: 1 },
        { name: 'doc_billing', maxCount: 1 },
        { name: 'doc_med_cert', maxCount: 1 },
        { name: 'doc_case_study', maxCount: 1 },
        { name: 'doc_social_case', maxCount: 1 },
        { name: 'doc_patient_id', maxCount: 1 },
        { name: 'doc_rep_id', maxCount: 1 },
        { name: 'doc_gov_id', maxCount: 1 },
        { name: 'doc_indigency', maxCount: 1 },
        { name: 'doc_patient_photo', maxCount: 1 },
        { name: 'file', maxCount: 1 },
        { name: 'document', maxCount: 1 }
    ]),
    async (req, res) => {
        const data = req.body;

        const getLocalName = (fieldName) =>
            (req.files && req.files[fieldName])
                ? req.files[fieldName][0].filename
                : null;

        const parseNum = (val) => (val && !isNaN(val) ? parseInt(val) : null);
        const parseStr = (val, defaultVal = 'N/A') => (val && String(val).trim() !== '' ? String(val).trim() : defaultVal);

        // Persist each file to Cloudinary (or keep local filename)
        const fileFields = {
            doc_coe: await persistFile(getLocalName('doc_coe')),
            doc_psa: await persistFile(getLocalName('doc_psa')),
            doc_report_card: await persistFile(getLocalName('doc_report_card')),
            doc_school_id: await persistFile(getLocalName('doc_school_id')),
            doc_billing: await persistFile(getLocalName('doc_billing')),
            doc_med_cert: await persistFile(getLocalName('doc_med_cert')),
            doc_social_case: await persistFile(getLocalName('doc_social_case') || getLocalName('doc_case_study')),
            doc_patient_id: await persistFile(getLocalName('doc_patient_id')),
            doc_rep_id: await persistFile(getLocalName('doc_rep_id')),
            doc_gov_id: await persistFile(getLocalName('doc_gov_id')),
            doc_indigency: await persistFile(getLocalName('doc_indigency')),
            doc_form: await persistFile(getLocalName('doc_form')),
            photo_2x2: await persistFile(getLocalName('photo_2x2') || getLocalName('id_photo_2x2')),
            doc_patient_photo: await persistFile(getLocalName('doc_patient_photo'))
        };

        const fullValues = [
            parseNum(data.user_id),
            parseStr(data.program_type, 'Educational Assistance'),
            parseStr(data.application_role),
            parseStr(data.first_name, ''),
            parseStr(data.middle_name, ''),
            parseStr(data.last_name, ''),
            data.dob && data.dob !== '' ? data.dob : null,
            parseNum(data.age),
            parseStr(data.civil_status),
            parseStr(data.sex),
            parseStr(data.street),
            parseStr(data.barangay),
            parseStr(data.municipality),
            parseStr(data.province),
            parseStr(data.mobile_number),
            parseStr(data.email),
            parseStr(data.gcash),
            parseStr(data.school_name),
            parseStr(data.year_level),
            parseStr(data.course),
            parseStr(data.father_name),
            parseStr(data.mother_name),
            parseStr(data.father_occ),
            parseStr(data.mother_occ),
            fileFields.doc_coe,
            fileFields.doc_psa,
            fileFields.doc_report_card,
            fileFields.doc_school_id,
            fileFields.doc_billing,
            fileFields.doc_med_cert,
            fileFields.doc_social_case,
            fileFields.doc_patient_id,
            fileFields.doc_rep_id,
            fileFields.doc_gov_id,
            fileFields.doc_indigency,
            fileFields.doc_form,
            fileFields.photo_2x2,
            fileFields.doc_patient_photo,
            'Pending'
        ];

        try {
            const result = await pool.query(`
                INSERT INTO submitted_programs (
                    user_id, program_type, application_role, first_name, middle_name,
                    last_name, dob, age, civil_status, sex, street, barangay,
                    municipality, province, mobile_number, email, gcash, school_name,
                    year_level, course, father_name, mother_name, father_occ, mother_occ,
                    doc_coe, doc_psa, doc_report_card, doc_school_id, doc_billing, doc_med_cert,
                    doc_social_case, doc_patient_id, doc_rep_id, doc_gov_id,
                    doc_indigency, doc_form, photo_2x2, doc_patient_photo, status
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                    $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
                    $31, $32, $33, $34, $35, $36, $37, $38, $39
                ) RETURNING *
            `, fullValues);

            io.emit('newApplication');

            if (data.user_id) {
                io.emit('application_status_updated', {
                    userId: data.user_id,
                    status: 'Pending'
                });
            }

            return res.status(200).json({ message: "Success", application: result.rows[0] });

        } catch (err) {
            console.error("PRIMARY INSERT ERROR:", err.message);

            try {
                const fallbackResult = await pool.query(`
                    INSERT INTO submitted_programs (
                        program_type, first_name, last_name, barangay, municipality, province, mobile_number, email, status
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending')
                    RETURNING *
                `, [
                    parseStr(data.program_type, 'Educational Assistance'),
                    parseStr(data.first_name, 'Applicant'),
                    parseStr(data.last_name, ''),
                    parseStr(data.barangay),
                    parseStr(data.municipality),
                    parseStr(data.province),
                    parseStr(data.mobile_number),
                    parseStr(data.email)
                ]);

                io.emit('newApplication');

                if (data.user_id) {
                    io.emit('application_status_updated', {
                        userId: data.user_id,
                        status: 'Pending'
                    });
                }

                return res.status(200).json({ message: "Success (Fallback)", application: fallbackResult.rows[0] });
            } catch (fallbackErr) {
                console.error("FALLBACK INSERT ERROR:", fallbackErr.message);
                return res.status(500).json({ error: err.message });
            }
        }
    }
);

// RECENT SUBMISSIONS
app.get('/api/recent-submissions', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT 
                id,
                CONCAT(first_name, ' ', last_name) AS full_name,
                program_type,
                status,
                TO_CHAR(submitted_at, 'Mon DD, YYYY HH:MI AM') AS date
            FROM submitted_programs
            ORDER BY id DESC
            LIMIT 10
            `
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("Error fetching recent submissions:", err.message);
        res.status(500).json({ error: "Failed to fetch recent submissions" });
    }
});

// =======================================================
// --- 10. SERVER START ---
// =======================================================
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
