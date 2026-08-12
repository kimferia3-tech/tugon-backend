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

pool.connect((err, client, release) => {
    if (err) return console.error('Error connecting to database:', err.stack);
    console.log('Successfully connected to Neon PostgreSQL!');
    release();
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
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(
            null,
            file.fieldname + '-' + Date.now() + path.extname(file.originalname)
        );
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

                io.emit(
                    'update_user_list',
                    Array.from(activeUsers)
                );

            }
        }
    });

    socket.on('request_user_list', () => {

        socket.emit(
            'update_user_list',
            Array.from(activeUsers)
        );

    });

    socket.on('get_chat_history', async (data) => {

        try {

            const result = await pool.query(
                `
                SELECT
                    sender,
                    message AS text,
                    TO_CHAR(created_at, 'HH12:MI AM') AS time
                FROM chat_messages
                WHERE room = $1
                ORDER BY created_at ASC
                `,
                [data.room]
            );

            socket.emit('chat_history', result.rows);

        } catch (err) {

            console.error(
                "Error fetching history:",
                err
            );

        }

    });

    socket.on('send_message', async (data) => {

        try {

            await pool.query(
                `
                INSERT INTO chat_messages
                (sender, message, room, created_at)
                VALUES ($1, $2, $3, NOW())
                `,
                [
                    data.sender,
                    data.text,
                    data.room
                ]
            );

            const realTime =
                new Date().toLocaleTimeString(
                    'en-US',
                    {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true
                    }
                );

            io.to(data.room).emit(
                'receive_message',
                {
                    text: data.text,
                    sender: data.sender,
                    time: realTime,
                    room: data.room
                }
            );

        } catch (err) {

            console.error(
                "Error saving/sending msg:",
                err
            );

        }

    });

    socket.on('typing', (data) => {

        socket
            .to(data.room)
            .emit(
                'display_typing',
                data
            );

    });

    socket.on('disconnect', () => {});

});

// --- 5. AUTHENTICATION ROUTES ---

app.post('/signup', async (req, res) => {

    const {
        fullname,
        email,
        password
    } = req.body;

    try {

        const hashedPassword =
            await bcrypt.hash(
                password,
                10
            );

        const result =
            await pool.query(
                `
                INSERT INTO users
                (fullname, email, password)
                VALUES ($1, $2, $3)
                RETURNING *
                `,
                [
                    fullname,
                    email,
                    hashedPassword
                ]
            );

        res.status(200).json({
            message: "User registered!",
            user: result.rows[0]
        });

    } catch (err) {

        res.status(500).json({
            error: "Database error!"
        });

    }

});

app.post('/login', async (req, res) => {

    const {
        email,
        password
    } = req.body;

    try {

        let result =
            await pool.query(
                'SELECT * FROM users WHERE email = $1',
                [email]
            );

        let userFound =
            result.rows[0];

        let isAdmin = false;

        if (!userFound) {

            result =
                await pool.query(
                    'SELECT * FROM admins WHERE email = $1',
                    [email]
                );

            userFound =
                result.rows[0];

            if (userFound)
                isAdmin = true;

        }

        if (userFound) {

            let isMatch = false;

            if (isAdmin) {

                isMatch =
                    password === userFound.password;

            } else {

                isMatch =
                    await bcrypt.compare(
                        password,
                        userFound.password
                    );

            }

            if (isMatch) {

                res.status(200).json({

                    message:
                        "Login successful",

                    user: {

                        id:
                            userFound.id,

                        fullname:
                            userFound.full_name ||
                            userFound.fullname,

                        role:
                            isAdmin
                                ? 'admin'
                                : (
                                    userFound.role
                                        ? userFound.role.toLowerCase()
                                        : 'user'
                                ),

                        email:
                            userFound.email

                    }

                });

            } else {

                res.status(401).json({
                    error: "Invalid credentials!"
                });

            }

        } else {

            res.status(401).json({
                error: "Invalid credentials!"
            });

        }

    } catch (err) {

        console.error(
            "Login Error:",
            err
        );

        res.status(500).json({
            error: "Server Error"
        });

    }

});

// =======================================================
// --- 6. APPLICATIONS / SUBMITTED PROGRAMS
// =======================================================

// GET ALL APPLICATIONS

app.get('/applications', async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT *,
                TO_CHAR(
                    submitted_at,
                    'Mon DD, YYYY'
                ) AS date
                FROM submitted_programs
                ORDER BY id DESC
                `
            );

        res.status(200).json(
            result.rows
        );

    } catch (err) {

        console.error(
            "Error fetching submitted_programs:",
            err.message
        );

        res.status(500).json({
            error:
                "Error fetching applications"
        });

    }

});


// =======================================================
// UPDATE APPLICATION STATUS
// =======================================================
// IMPORTANT:
// This route fixes the:
// Cannot PUT /applications/:id/status
// 404 error from the Admin Dashboard.
// =======================================================

app.put('/applications/:id/status', async (req, res) => {

    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = [
        'Pending',
        'Approved',
        'Rejected'
    ];

    if (!allowedStatuses.includes(status)) {

        return res.status(400).json({
            error: 'Invalid application status'
        });

    }

    try {

        const result =
            await pool.query(
                `
                UPDATE submitted_programs
                SET status = $1
                WHERE id = $2
                RETURNING *
                `,
                [
                    status,
                    id
                ]
            );

        if (result.rows.length === 0) {

            return res.status(404).json({
                error:
                    'Application not found'
            });

        }

        const updatedApplication =
            result.rows[0];

        console.log(
            `Application ${id} status changed to ${status}`
        );

        // Realtime update for Admin Dashboard
        io.emit(
            'applicationStatusUpdated',
            updatedApplication
        );

        // Existing event naming compatibility
        io.emit(
            'application_status_updated',
            {
                userId:
                    updatedApplication.user_id,

                applicationId:
                    updatedApplication.id,

                status:
                    updatedApplication.status
            }
        );

        res.status(200).json({

            message:
                'Application status updated successfully',

            application:
                updatedApplication

        });

    } catch (err) {

        console.error(
            'Error updating application status:',
            err.message
        );

        res.status(500).json({
            error:
                'Failed to update application status'
        });

    }

});


// ADD NEW APPLICANT
// Existing route retained

app.post('/applications', async (req, res) => {

    const {
        fullName,
        full_name,
        municipality,
        barangay,
        program,
        phone
    } = req.body;

    const applicantName =
        fullName || full_name;

    try {

        const queryText = `
            INSERT INTO new_applications
            (
                full_name,
                municipality,
                barangay,
                program,
                phone,
                status
            )
            VALUES
            (
                $1,
                $2,
                $3,
                $4,
                $5,
                'Pending'
            )
            RETURNING *;
        `;

        const values = [
            applicantName,
            municipality,
            barangay,
            program,
            phone
        ];

        const result =
            await pool.query(
                queryText,
                values
            );

        io.emit(
            'newApplication',
            result.rows[0]
        );

        res.status(200).json({

            message:
                "Applicant registered successfully!",

            application:
                result.rows[0]

        });

    } catch (err) {

        console.error(
            "Error inserting into new_applications:",
            err.message
        );

        res.status(500).json({
            error: err.message
        });

    }

});


// DATABASE DEBUG

app.get('/debug/database', async (req, res) => {

    try {

        const db =
            await pool.query(
                `
                SELECT
                    current_database()
                    AS database_name,

                    current_user
                    AS database_user
                `
            );

        const count =
            await pool.query(
                `
                SELECT COUNT(*) AS total
                FROM submitted_programs
                `
            );

        res.json({

            database:
                db.rows[0],

            submitted_programs_total:
                count.rows[0].total

        });

    } catch (err) {

        console.error(
            "DATABASE DEBUG ERROR:",
            err.message
        );

        res.status(500).json({
            error:
                err.message
        });

    }

});


// =======================================================
// --- 7. NEW SETTINGS & ADMIN PROFILE
// =======================================================

// GET SETTINGS

app.get('/api/settings', async (req, res) => {

    try {

        const result =
            await pool.query(
                "SELECT * FROM new_settings WHERE id = 1"
            );

        res.status(200).json(
            result.rows[0] || {}
        );

    } catch (err) {

        console.error(
            "Error fetching settings:",
            err.message
        );

        res.status(500).json({
            error: err.message
        });

    }

});


// UPDATE SETTINGS

app.post('/api/settings', async (req, res) => {

    const {
        standardAmount,
        totalFunds,
        autoApproval,
        emailNotifications
    } = req.body;

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
            totalFunds || 100000.00,
            autoApproval || 'Disabled',
            emailNotifications || 'Enabled'
        ];

        const result =
            await pool.query(
                queryText,
                values
            );

        res.status(200).json({

            message:
                "Settings updated successfully!",

            settings:
                result.rows[0]

        });

    } catch (err) {

        console.error(
            "Error updating settings:",
            err.message
        );

        res.status(500).json({
            error:
                err.message
        });

    }

});


// UPDATE ADMIN PROFILE

app.post('/api/admin/profile', async (req, res) => {

    const {
        name,
        role
    } = req.body;

    try {

        const queryText = `
            UPDATE new_settings
            SET
                director_name = $1,
                role_title = $2
            WHERE id = 1
            RETURNING *;
        `;

        const result =
            await pool.query(
                queryText,
                [
                    name,
                    role
                ]
            );

        res.status(200).json({

            message:
                "Admin profile updated successfully!",

            profile:
                result.rows[0]

        });

    } catch (err) {

        console.error(
            "Error updating admin profile:",
            err.message
        );

        res.status(500).json({
            error:
                err.message
        });

    }

});


// =======================================================
// --- 8. NEW WEBINARS ENDPOINTS
// =======================================================

// GET WEBINARS

app.get('/api/webinars', async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT *,
                TO_CHAR(
                    schedule_date,
                    'Mon DD, YYYY HH:MI AM'
                ) AS date_formatted
                FROM new_webinars
                ORDER BY schedule_date ASC
                `
            );

        res.status(200).json(
            result.rows
        );

    } catch (err) {

        console.error(
            "Error fetching webinars:",
            err.message
        );

        res.status(500).json({
            error:
                err.message
        });

    }

});


// CREATE WEBINAR

app.post('/api/webinars', async (req, res) => {

    const {
        title,
        description,
        schedule_date
    } = req.body;

    try {

        const queryText = `
            INSERT INTO new_webinars
            (
                title,
                description,
                schedule_date
            )
            VALUES
            (
                $1,
                $2,
                $3
            )
            RETURNING *;
        `;

        const result =
            await pool.query(
                queryText,
                [
                    title,
                    description,
                    schedule_date || new Date()
                ]
            );

        res.status(200).json({

            message:
                "Webinar created successfully!",

            webinar:
                result.rows[0]

        });

    } catch (err) {

        console.error(
            "Error creating webinar:",
            err.message
        );

        res.status(500).json({
            error:
                err.message
        });

    }

});


// =======================================================
// --- EXISTING SUBMIT PROGRAM & OTHER LEGACY ROUTES
// =======================================================

app.post(
    '/submit-program',

    upload.fields([

        {
            name: 'photo_2x2',
            maxCount: 1
        },

        {
            name: 'id_photo_2x2',
            maxCount: 1
        },

        {
            name: 'doc_coe',
            maxCount: 1
        },

        {
            name: 'doc_psa',
            maxCount: 1
        },

        {
            name: 'doc_school_id',
            maxCount: 1
        },

        {
            name: 'doc_form',
            maxCount: 1
        },

        {
            name: 'doc_billing',
            maxCount: 1
        },

        {
            name: 'doc_med_cert',
            maxCount: 1
        },

        {
            name: 'doc_case_study',
            maxCount: 1
        },

        {
            name: 'doc_patient_id',
            maxCount: 1
        },

        {
            name: 'doc_rep_id',
            maxCount: 1
        },

        {
            name: 'doc_gov_id',
            maxCount: 1
        },

        {
            name: 'doc_indigency',
            maxCount: 1
        },

        {
            name: 'doc_patient_photo',
            maxCount: 1
        }

    ]),

    async (req, res) => {

        const data =
            req.body;

        const getFileName =
            (fieldName) =>
                (
                    req.files &&
                    req.files[fieldName]
                )
                    ? req.files[fieldName][0].filename
                    : null;

        try {

            const queryText = `
                INSERT INTO submitted_programs
                (
                    user_id,
                    program_type,
                    application_role,
                    first_name,
                    middle_name,
                    last_name,
                    dob,
                    age,
                    civil_status,
                    sex,
                    street,
                    barangay,
                    municipality,
                    province,
                    mobile_number,
                    email,
                    gcash,
                    school_name,
                    year_level,
                    course,
                    father_name,
                    mother_name,
                    father_occ,
                    mother_occ,
                    doc_coe,
                    doc_psa,
                    doc_school_id,
                    doc_billing,
                    doc_med_cert,
                    doc_social_case,
                    doc_patient_id,
                    doc_rep_id,
                    doc_gov_id,
                    doc_indigency,
                    doc_form,
                    photo_2x2,
                    doc_patient_photo,
                    status
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11,
                    $12,
                    $13,
                    $14,
                    $15,
                    $16,
                    $17,
                    $18,
                    $19,
                    $20,
                    $21,
                    $22,
                    $23,
                    $24,
                    $25,
                    $26,
                    $27,
                    $28,
                    $29,
                    $30,
                    $31,
                    $32,
                    $33,
                    $34,
                    $35,
                    $36,
                    $37,
                    $38
                )
                RETURNING *
            `;

            const values = [

                data.user_id || null,

                data.program_type,

                data.application_role || 'N/A',

                data.first_name,

                data.middle_name || '',

                data.last_name,

                data.dob || null,

                data.age
                    ? parseInt(data.age)
                    : null,

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

                getFileName('doc_coe'),

                getFileName('doc_psa'),

                getFileName('doc_school_id'),

                getFileName('doc_billing'),

                getFileName('doc_med_cert'),

                getFileName('doc_case_study'),

                getFileName('doc_patient_id'),

                getFileName('doc_rep_id'),

                getFileName('doc_gov_id'),

                getFileName('doc_indigency'),

                getFileName('doc_form'),

                getFileName('photo_2x2') ||
                getFileName('id_photo_2x2'),

                getFileName('doc_patient_photo'),

                'Pending'

            ];

            const result =
                await pool.query(
                    queryText,
                    values
                );

            io.emit(
                'newApplication'
            );

            if (data.user_id) {

                io.emit(
                    'application_status_updated',
                    {
                        userId:
                            data.user_id,

                        status:
                            'Pending'
                    }
                );

            }

            res.status(200).json({

                message:
                    "Success",

                application:
                    result.rows[0]

            });

        } catch (err) {

            console.error(
                "DETALYE NG ERROR:",
                err.message
            );

            res.status(500).json({
                error:
                    err.message
            });

        }

    }
);


// RECENT SUBMISSIONS

app.get('/api/recent-submissions', async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT
                    id,
                    CONCAT(
                        first_name,
                        ' ',
                        last_name
                    ) AS applicant,
                    municipality,
                    program_type AS program,
                    status
                FROM submitted_programs
                ORDER BY id DESC
                LIMIT 5
                `
            );

        res.status(200).json(
            result.rows
        );

    } catch (err) {

        console.error(
            "Error fetching recent submissions:",
            err.message
        );

        res.status(500).json({
            error:
                "Failed to fetch recent submissions"
        });

    }

});


// --- SERVER START ---

const PORT =
    process.env.PORT || 10000;

server.listen(
    PORT,
    () => {
        console.log(
            `Server running on port ${PORT}`
        );
    }
);
