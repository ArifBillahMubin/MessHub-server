const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { MongoClient, ServerApiVersion } = require('mongodb')
const admin = require('firebase-admin')
const port = process.env.PORT || 3000
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
  'utf-8'
)
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()
// middleware
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {

    const db = client.db('messHub')
    const userCollections = db.collection('users')
    const messCollections = db.collection('messes')
    const messMemberCollections = db.collection('messMembers')
    const joinRequestCollections = db.collection('joinRequests')



    //save user in db 
    //

    try {
      await userCollections.createIndex({ email: 1 }, { unique: true })
      console.log('Unique index on email ensured.')
    } catch (indexErr) {
      console.warn('Could not create email index (non-fatal):', indexErr.message)
    }

    // Unique index on messCode — prevents duplicate codes at DB level
    try {
      await messCollections.createIndex({ messCode: 1 }, { unique: true })
      console.log('Unique index on messCode ensured.')
    } catch (indexErr) {
      console.warn('Could not create messCode index (non-fatal):', indexErr.message)
    }

    //  Mess Code Generator 
    // Format: MH + 6 uppercase alphanumeric chars, excluding confusing chars (I O 0 1)
    const SAFE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const generateMessCode = () => {
      let code = 'MH'
      for (let i = 0; i < 6; i++) {
        code += SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)]
      }
      return code
    }

    // Generates a unique messCode that does not already exist in the DB
    const generateUniqueMessCode = async () => {
      let code
      let attempts = 0
      do {
        code = generateMessCode()
        attempts++
        if (attempts > 20) throw new Error('Could not generate a unique mess code.')
        const existing = await messCollections.findOne({ messCode: code })
        if (!existing) break
      } while (true)
      return code
    }

    //  POST /messes 
    // Creates a new mess, a messMembers record (role: manager), and sets hasMess=true on the user.
    app.post('/messes', async (req, res) => {
      const { email, name, description, location, maxMembers } = req.body

      // Basic validation
      if (!email) return res.status(400).send({ message: 'Email is required.' })
      if (!name?.trim()) return res.status(400).send({ message: 'Mess name is required.' })
      if (!location?.address?.trim()) return res.status(400).send({ message: 'Location address is required.' })
      if (location?.latitude == null || location?.longitude == null) {
        return res.status(400).send({ message: 'Latitude and longitude are required.' })
      }
      if (!maxMembers || Number(maxMembers) < 1) {
        return res.status(400).send({ message: 'Maximum members must be a positive number.' })
      }

      // Resolve the user document from their email
      const creator = await userCollections.findOne({ email })
      if (!creator) return res.status(404).send({ message: 'User not found.' })

      // Prevent creating multiple messes when hasMess is already true
      if (creator.hasMess) {
        return res.status(409).send({ message: 'You already have a mess.' })
      }

      try {
        const messCode = await generateUniqueMessCode()
        const now = new Date()

        // 1. Create the mess document
        const newMess = {
          name: name.trim(),
          messCode,
          description: description?.trim() || '',
          location: {
            address: location.address?.trim() || '',
            area: location.area?.trim() || '',
            city: location.city?.trim() || '',
            cityCorporation: location.cityCorporation?.trim() || '',
            latitude: Number(location.latitude),
            longitude: Number(location.longitude),
          },
          maxMembers: Number(maxMembers),
          createdBy: creator._id,
          status: 'active',
          settings: {
            mealSystem: 'equal',
            expenseSplit: 'equal',
            currency: 'BDT',
            timezone: 'Asia/Dhaka',
          },
          recruitment: {
            isPublic: false,
            acceptingMembers: false,
          },
          createdAt: now,
          updatedAt: now,
        }

        const messResult = await messCollections.insertOne(newMess)
        const messId = messResult.insertedId

        // 2. Create messMembers record — creator becomes manager
        const memberRecord = {
          userId: creator._id,
          messId,
          role: 'manager',
          status: 'active',
          joinedAt: now,
          leftAt: null,
          createdAt: now,
          updatedAt: now,
        }
        await messMemberCollections.insertOne(memberRecord)

        // 3. Mark user as having a mess
        await userCollections.updateOne(
          { _id: creator._id },
          { $set: { hasMess: true, updatedAt: now } }
        )

        return res.status(201).send({
          success: true,
          message: 'Mess created successfully.',
          messId: messId.toString(),
          messCode,
          name: newMess.name,
        })
      } catch (err) {
        console.error('Error creating mess:', err)
        // Handle duplicate messCode collision (shouldn't happen with generateUniqueMessCode but safety net)
        if (err.code === 11000) {
          return res.status(500).send({ message: 'Failed to generate unique mess code. Please try again.' })
        }
        return res.status(500).send({ message: 'Internal server error.' })
      }
    })

    // create a new user only if the email does not already exist
    app.post('/users', async (req, res) => {
      const { email, name, photoURL, phone, location, status, bio } = req.body

      if (!email) {
        return res.status(400).send({ message: 'Email is required.' })
      }

      // Check whether this email already has a MongoDB 
      const existingUser = await userCollections.findOne({ email })

      if (existingUser) {
        // User already exists
        return res.status(200).send({
          inserted: false,
          message: 'User already exists.',
          user: existingUser,
        })
      }

      // New user
      const now = new Date()
      const newUser = {
        email,
        name: name || '',
        photoURL: photoURL || '',
        phone: phone || '',
        location: location || '',
        status: status || '',
        bio: bio || '',
        role: 'member',
        hasMess: false,
        accountStatus: 'active',
        createdAt: now,
        updatedAt: now,
      }

      try {
        const result = await userCollections.insertOne(newUser)
        return res.status(201).send({
          inserted: true,
          message: 'User created successfully.',
          insertedId: result.insertedId,
        })
      } catch (err) {
        // Handle rare race-condition duplicate-key error from the unique index
        if (err.code === 11000) {
          const existing = await userCollections.findOne({ email })
          return res.status(200).send({
            inserted: false,
            message: 'User already exists.',
            user: existing,
          })
        }
        console.error('Error creating user:', err)
        return res.status(500).send({ message: 'Internal server error.' })
      }
    })

    // GET /users/mess-role — returns the user's effective role in their active mess
    // Returns { messRole: "manager" | "member" | null }
    // null means the user has no active messMembers record (hasMess is false or no record yet)
    app.get('/users/mess-role', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })

      // No mess at all — short-circuit
      if (!user.hasMess) return res.send({ messRole: null })

      // Find the most recent active membership record for this user
      const membership = await messMemberCollections.findOne(
        { userId: user._id, status: 'active' },
        { sort: { joinedAt: -1 } }
      )

      res.send({ messRole: membership?.role ?? null })
    })

    // GET /user/role — returns the user's global account role (member / super_admin)
    app.get('/user/role', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })
      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })
      res.send({ role: user.role || 'member' })
    })

    // GET /users/me 
    app.get('/users/me', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })
      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })
      res.send(user)
    })





    // GET /users/my-mess — returns the mess document the current user is actively a member of
    app.get('/users/my-mess', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })
      if (!user.hasMess) return res.send({ mess: null })

      const membership = await messMemberCollections.findOne(
        { userId: user._id, status: 'active' },
        { sort: { joinedAt: -1 } }
      )
      if (!membership) return res.send({ mess: null })

      const mess = await messCollections.findOne({ _id: membership.messId })
      return res.send({ mess: mess || null, role: membership.role })
    })

    // GET /messes/find-by-code — look up a mess by its code (used by Join Mess page)
    app.get('/messes/find-by-code', async (req, res) => {
      const { code } = req.query
      if (!code?.trim()) return res.status(400).send({ message: 'Mess code is required.' })

      const mess = await messCollections.findOne({ messCode: code.trim().toUpperCase() })
      if (!mess) return res.status(404).send({ message: 'No mess found with that code.' })
      if (mess.status !== 'active') return res.status(400).send({ message: 'This mess is no longer active.' })

      // Count active members so the frontend can show available seats
      const activeMembers = await messMemberCollections.countDocuments({
        messId: mess._id,
        status: 'active',
      })

      return res.send({
        _id: mess._id,
        name: mess.name,
        messCode: mess.messCode,
        description: mess.description,
        location: { address: mess.location?.address || '', city: mess.location?.city || '' },
        maxMembers: mess.maxMembers,
        activeMembers,
        status: mess.status,
      })
    })

    // POST /join-requests — submit a join request for a mess
    app.post('/join-requests', async (req, res) => {
      const { email, messCode, name, phone } = req.body
      if (!email || !messCode) return res.status(400).send({ message: 'Email and mess code are required.' })

      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })

      if (user.hasMess) return res.status(409).send({ message: 'You are already part of a mess.' })

      const mess = await messCollections.findOne({ messCode: messCode.trim().toUpperCase() })
      if (!mess) return res.status(404).send({ message: 'Mess not found.' })
      if (mess.status !== 'active') return res.status(400).send({ message: 'This mess is no longer active.' })

      // Block if the mess is full
      const activeCount = await messMemberCollections.countDocuments({ messId: mess._id, status: 'active' })
      if (activeCount >= mess.maxMembers) {
        return res.status(400).send({ message: 'This mess has reached its maximum member limit.' })
      }

      // Block duplicate pending requests
      const existing = await joinRequestCollections.findOne({
        userId: user._id,
        messId: mess._id,
        status: 'pending',
      })
      if (existing) return res.status(409).send({ message: 'You already have a pending request for this mess.' })

      const now = new Date()
      const joinRequest = {
        messId: mess._id,
        userId: user._id,
        name: name?.trim() || user.name || '',
        email: user.email,
        phone: phone?.trim() || user.phone || '',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }

      const result = await joinRequestCollections.insertOne(joinRequest)
      return res.status(201).send({ success: true, requestId: result.insertedId })
    })

    // GET /join-requests/my-pending — fetch the current user's pending requests (for MessSetup page)
    app.get('/join-requests/my-pending', async (req, res) => {
      const { email } = req.query
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      const user = await userCollections.findOne({ email })
      if (!user) return res.status(404).send({ message: 'User not found.' })

      const requests = await joinRequestCollections
        .aggregate([
          { $match: { userId: user._id, status: { $in: ['pending', 'rejected'] } } },
          { $sort: { createdAt: -1 } },
          {
            $lookup: {
              from: 'messes',
              localField: 'messId',
              foreignField: '_id',
              as: 'mess',
            },
          },
          { $unwind: { path: '$mess', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              status: 1,
              createdAt: 1,
              messName: '$mess.name',
              messCode: '$mess.messCode',
            },
          },
        ])
        .toArray()

      return res.send(requests)
    })

    // GET /join-requests/mess/:messId — get all requests for a mess (manager view)
    app.get('/join-requests/mess/:messId', async (req, res) => {
      const { messId } = req.params
      const { ObjectId } = require('mongodb')

      let messObjectId
      try { messObjectId = new ObjectId(messId) } catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const requests = await joinRequestCollections
        .find({ messId: messObjectId, status: 'pending' })
        .sort({ createdAt: 1 })
        .toArray()

      return res.send(requests)
    })

    // PATCH /join-requests/:id/approve — manager approves a request
    app.patch('/join-requests/:id/approve', async (req, res) => {
      const { ObjectId } = require('mongodb')

      let reqObjectId
      try { reqObjectId = new ObjectId(req.params.id) } catch { return res.status(400).send({ message: 'Invalid request ID.' }) }

      const joinReq = await joinRequestCollections.findOne({ _id: reqObjectId })
      if (!joinReq) return res.status(404).send({ message: 'Join request not found.' })
      if (joinReq.status !== 'pending') return res.status(400).send({ message: 'Request is no longer pending.' })

      const mess = await messCollections.findOne({ _id: joinReq.messId })
      if (!mess || mess.status !== 'active') return res.status(400).send({ message: 'Mess is not active.' })

      // Re-check capacity before approving
      const activeCount = await messMemberCollections.countDocuments({ messId: joinReq.messId, status: 'active' })
      if (activeCount >= mess.maxMembers) {
        return res.status(400).send({ message: 'Mess is now full. Cannot approve.' })
      }

      const now = new Date()

      await joinRequestCollections.updateOne(
        { _id: reqObjectId },
        { $set: { status: 'approved', updatedAt: now } }
      )

      await messMemberCollections.insertOne({
        userId: joinReq.userId,
        messId: joinReq.messId,
        role: 'member',
        status: 'active',
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
      })

      await userCollections.updateOne(
        { _id: joinReq.userId },
        { $set: { hasMess: true, updatedAt: now } }
      )

      return res.send({ success: true, message: 'Request approved.' })
    })

    // PATCH /join-requests/:id/reject — manager rejects a request
    app.patch('/join-requests/:id/reject', async (req, res) => {
      const { ObjectId } = require('mongodb')

      let reqObjectId
      try { reqObjectId = new ObjectId(req.params.id) } catch { return res.status(400).send({ message: 'Invalid request ID.' }) }

      const joinReq = await joinRequestCollections.findOne({ _id: reqObjectId })
      if (!joinReq) return res.status(404).send({ message: 'Join request not found.' })
      if (joinReq.status !== 'pending') return res.status(400).send({ message: 'Request is no longer pending.' })

      await joinRequestCollections.updateOne(
        { _id: reqObjectId },
        { $set: { status: 'rejected', updatedAt: new Date() } }
      )

      return res.send({ success: true, message: 'Request rejected.' })
    })

    // GET /mess-members/:messId — paginated member list with search and role filter
    app.get('/mess-members/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { search = '', role = '', page = '1', limit = '10' } = req.query

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const mess = await messCollections.findOne({ _id: messObjectId })
      if (!mess) return res.status(404).send({ message: 'Mess not found.' })

      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.min(50, Math.max(1, parseInt(limit)))
      const skip = (pageNum - 1) * limitNum

      // Build the aggregation pipeline
      const pipeline = [
        // Only active members of this mess
        { $match: { messId: messObjectId, status: 'active' } },

        // Join user profile data
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },

        // Apply role filter (manager | member | '')
        ...(role ? [{ $match: { role } }] : []),

        // Apply text search against name, email, phone from the joined user
        ...(search
          ? [{
              $match: {
                $or: [
                  { 'user.name':  { $regex: search, $options: 'i' } },
                  { 'user.email': { $regex: search, $options: 'i' } },
                  { 'user.phone': { $regex: search, $options: 'i' } },
                ],
              },
            }]
          : []),

        // Project only the fields the frontend needs
        {
          $project: {
            _id: 1,
            role: 1,
            status: 1,
            joinedAt: 1,
            name:     '$user.name',
            email:    '$user.email',
            phone:    '$user.phone',
            photoURL: '$user.photoURL',
          },
        },
        { $sort: { joinedAt: 1 } },
      ]

      // Run count and paginated data in parallel
      const [countResult, members] = await Promise.all([
        messMemberCollections.aggregate([...pipeline, { $count: 'total' }]).toArray(),
        messMemberCollections.aggregate([...pipeline, { $skip: skip }, { $limit: limitNum }]).toArray(),
      ])

      const total = countResult[0]?.total ?? 0
      const totalMembers = await messMemberCollections.countDocuments({ messId: messObjectId, status: 'active' })

      return res.send({
        members,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
        summary: {
          totalMembers,
          maxMembers: mess.maxMembers,
          availableSeats: Math.max(0, mess.maxMembers - totalMembers),
          messName: mess.name,
        },
      })
    })

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
