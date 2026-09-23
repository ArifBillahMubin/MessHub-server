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
    const messPostCollections = db.collection('messPosts')
    const mealCollections = db.collection('meals')
    const bazarCollections = db.collection('bazar')
    const bazarAssignmentsCollections = db.collection('bazarAssignments')
    const khalabillCollections = db.collection('khalabill')
    const commonExpensesCollections = db.collection('commonExpenses')
    const memberRentCollections = db.collection('memberRent')
    const paymentsCollections = db.collection('payments')
    const notificationsCollections = db.collection('notifications')
    const monthlyReportsCollections = db.collection('monthlyReports')



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

    // Notification indexes for efficient queries
    try {
      await notificationsCollections.createIndex({ userId: 1, messId: 1, isRead: 1, createdAt: -1 })
      await notificationsCollections.createIndex({ messId: 1, createdAt: -1 })
      console.log('Notification indexes ensured.')
    } catch (indexErr) {
      console.warn('Could not create notification indexes (non-fatal):', indexErr.message)
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

    // PATCH /users/me — update current user profile (editable fields only)
    app.patch('/users/me', async (req, res) => {
      const { email, name, photoURL, phone, location, bio } = req.body

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      try {
        // Find the current user by email
        const user = await userCollections.findOne({ email })
        if (!user) return res.status(404).send({ message: 'User not found.' })

        // Build update object with only allowed fields
        const updates = { updatedAt: new Date() }

        if (name !== undefined) {
          const trimmedName = name?.trim()
          if (!trimmedName) return res.status(400).send({ message: 'Name cannot be empty.' })
          updates.name = trimmedName
        }

        if (photoURL !== undefined) {
          updates.photoURL = photoURL?.trim() || ''
        }

        if (phone !== undefined) {
          updates.phone = phone?.trim() || ''
        }

        if (location !== undefined) {
          updates.location = location?.trim() || ''
        }

        if (bio !== undefined) {
          updates.bio = bio?.trim() || ''
        }

        // Update the user document
        const result = await userCollections.updateOne(
          { email },
          { $set: updates }
        )

        if (result.modifiedCount === 0) {
          return res.status(304).send({ message: 'No changes made.' })
        }

        // Return updated user
        const updatedUser = await userCollections.findOne({ email })
        res.send({ message: 'Profile updated successfully.', user: updatedUser })
      } catch (err) {
        console.error('Failed to update user profile:', err)
        res.status(500).send({ message: 'Failed to update profile.' })
      }
    })





    // PATCH /messes/:id — update basic mess information (manager only)
    app.patch('/messes/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, name, description, location, maxMembers } = req.body

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      // Verify the caller is the active manager of this mess
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id, messId: messObjectId, role: 'manager', status: 'active',
      })
      if (!membership) return res.status(403).send({ message: 'You are not the manager of this mess.' })

      const mess = await messCollections.findOne({ _id: messObjectId })
      if (!mess) return res.status(404).send({ message: 'Mess not found.' })

      const updates = { updatedAt: new Date() }

      if (name !== undefined) {
        if (!name.trim()) return res.status(400).send({ message: 'Mess name cannot be empty.' })
        updates.name = name.trim()
      }
      if (description !== undefined) updates.description = description?.trim() || ''

      if (maxMembers !== undefined) {
        const max = Number(maxMembers)
        if (!max || max < 1) return res.status(400).send({ message: 'Maximum members must be a positive number.' })
        // Cannot set maxMembers below current active member count
        const activeCount = await messMemberCollections.countDocuments({ messId: messObjectId, status: 'active' })
        if (max < activeCount) {
          return res.status(400).send({
            message: `Maximum members cannot be less than current active members (${activeCount}).`,
          })
        }
        updates.maxMembers = max
      }

      if (location !== undefined) {
        if (!location.address?.trim()) return res.status(400).send({ message: 'Location address is required.' })
        if (location.latitude == null || location.longitude == null) {
          return res.status(400).send({ message: 'Latitude and longitude are required.' })
        }
        updates.location = {
          address:       location.address?.trim()       || mess.location?.address       || '',
          area:          location.area?.trim()          || mess.location?.area          || '',
          city:          location.city?.trim()          || mess.location?.city          || '',
          cityCorporation: location.cityCorporation?.trim() || mess.location?.cityCorporation || '',
          latitude:      Number(location.latitude),
          longitude:     Number(location.longitude),
        }
      }

      await messCollections.updateOne({ _id: messObjectId }, { $set: updates })

      const updated = await messCollections.findOne({ _id: messObjectId })
      return res.send({ success: true, mess: updated })
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
      
      console.log('[Join Request] Created successfully, now checking for manager to notify')
      
      // Notify manager about new join request
      const manager = await messMemberCollections.findOne({ messId: mess._id, role: 'manager', status: 'active' })
      
      if (manager) {
        console.log('[Join Request] Manager found:', manager.userId?.toString())
        await createNotification({
          userId: manager.userId,
          messId: mess._id,
          type: 'join_request',
          title: 'New Join Request',
          message: `${joinRequest.name || 'A user'} has requested to join your mess.`,
          link: '/dashboard/mess/join-requests'
        })
      } else {
        console.log('[Join Request] No manager found for mess:', mess._id?.toString())
      }

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

      console.log('[Join Request Approval] Creating approval notification for user:', joinReq.userId?.toString())

      // Create notification for approved member
      await createNotification({
        userId: joinReq.userId,
        messId: joinReq.messId,
        type: 'join_request_approved',
        title: 'Join Request Approved',
        message: `Your request to join ${mess.messName} has been approved.`,
        link: '/dashboard'
      })

      // NOTIFICATION: capacity_warning → notify manager if mess is nearing full capacity (90%+)
      const newActiveCount = activeCount + 1
      const capacityPercent = (newActiveCount / mess.maxMembers) * 100

      if (capacityPercent >= 90) {
        // Get manager
        const manager = await messMemberCollections.findOne({
          messId: joinReq.messId,
          role: 'manager',
          status: 'active'
        })

        if (manager) {
          await createNotification({
            userId: manager.userId,
            messId: joinReq.messId,
            type: 'capacity_warning',
            title: 'Capacity Warning',
            message: `Your mess is at ${capacityPercent.toFixed(0)}% capacity (${newActiveCount}/${mess.maxMembers} members).`,
            link: '/dashboard/members'
          })
          console.log(`[NOTIFICATION] capacity_warning created for manager ${manager.userId} - ${newActiveCount}/${mess.maxMembers}`)
        }
      }

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

      const mess = await messCollections.findOne({ _id: joinReq.messId })

      await joinRequestCollections.updateOne(
        { _id: reqObjectId },
        { $set: { status: 'rejected', updatedAt: new Date() } }
      )

      // Create notification for rejected member
      if (mess) {
        await createNotification({
          userId: joinReq.userId,
          messId: joinReq.messId,
          type: 'join_request_rejected',
          title: 'Join Request Rejected',
          message: `Your request to join ${mess.messName} was not approved.`,
          link: '/dashboard/join-mess'
        })
      }

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
            userId: 1,
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

    // ── Mess Posts ────────────────────────────────────────────────────────────

    // Helper: resolve the manager's active mess and verify ownership
    const resolveManagerMess = async (email) => {
      const { ObjectId } = require('mongodb')
      const user = await userCollections.findOne({ email })
      if (!user) return { error: 'User not found.', status: 404 }
      if (!user.hasMess) return { error: 'You do not have an active mess.', status: 403 }
      const membership = await messMemberCollections.findOne(
        { userId: user._id, status: 'active', role: 'manager' },
        { sort: { joinedAt: -1 } }
      )
      if (!membership) return { error: 'You are not a manager of any mess.', status: 403 }
      const mess = await messCollections.findOne({ _id: membership.messId })
      if (!mess) return { error: 'Mess not found.', status: 404 }
      const activeMembers = await messMemberCollections.countDocuments({ messId: mess._id, status: 'active' })
      return { user, mess, messId: mess._id, activeMembers }
    }

    // GET /mess-posts/mess/:messId — all posts for a mess
    app.get('/mess-posts/mess/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const posts = await messPostCollections
        .find({ messId: messObjectId })
        .sort({ updatedAt: -1 })
        .toArray()
      return res.send(posts)
    })

    // GET /mess-posts/:id — single post
    app.get('/mess-posts/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      let postId
      try { postId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid post ID.' }) }

      const post = await messPostCollections.findOne({ _id: postId })
      if (!post) return res.status(404).send({ message: 'Post not found.' })
      return res.send(post)
    })

    // POST /mess-posts — create a post
    app.post('/mess-posts', async (req, res) => {
      const { email, title, description, advertisedSeats, messType, roomType, foodSystem,
              facilities, approximateMonthlyCost, rent, additionalCost, costNote,
              images, preferredMemberTypes, additionalInformation, status } = req.body

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      const resolved = await resolveManagerMess(email)
      if (resolved.error) return res.status(resolved.status).send({ message: resolved.error })
      const { user, mess, messId, activeMembers } = resolved

      const postStatus = status === 'published' ? 'published' : 'draft'
      const seats = Number(advertisedSeats) || 0
      const availableSeats = Math.max(0, mess.maxMembers - activeMembers)

      // Validate for published posts
      if (postStatus === 'published') {
        if (!title?.trim()) return res.status(400).send({ message: 'Title is required to publish.' })
        if (!description?.trim()) return res.status(400).send({ message: 'Description is required to publish.' })
        if (!images || images.length === 0) return res.status(400).send({ message: 'At least one image is required to publish.' })
        if (availableSeats <= 0) return res.status(400).send({ message: 'No available seats to advertise.' })
        if (seats < 1 || seats > availableSeats) return res.status(400).send({ message: `Advertised seats must be between 1 and ${availableSeats}.` })
      } else if (seats > 0 && seats > availableSeats) {
        return res.status(400).send({ message: `Advertised seats cannot exceed available seats (${availableSeats}).` })
      }

      const now = new Date()
      const newPost = {
        messId,
        createdBy: user._id,
        title: title?.trim() || '',
        description: description?.trim() || '',
        advertisedSeats: seats,
        messType: messType || '',
        roomType: roomType || '',
        foodSystem: foodSystem || '',
        facilities: Array.isArray(facilities) ? facilities : [],
        approximateMonthlyCost: Number(approximateMonthlyCost) || 0,
        rent: Number(rent) || 0,
        additionalCost: Number(additionalCost) || 0,
        costNote: costNote?.trim() || '',
        images: Array.isArray(images) ? images : [],
        preferredMemberTypes: Array.isArray(preferredMemberTypes) ? preferredMemberTypes : [],
        additionalInformation: additionalInformation?.trim() || '',
        status: postStatus,
        createdAt: now,
        updatedAt: now,
      }

      const result = await messPostCollections.insertOne(newPost)
      return res.status(201).send({ success: true, postId: result.insertedId, status: postStatus })
    })

    // PATCH /mess-posts/:id — update a post
    app.patch('/mess-posts/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, title, description, advertisedSeats, messType, roomType, foodSystem,
              facilities, approximateMonthlyCost, rent, additionalCost, costNote,
              images, preferredMemberTypes, additionalInformation, status } = req.body

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      let postId
      try { postId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid post ID.' }) }

      const resolved = await resolveManagerMess(email)
      if (resolved.error) return res.status(resolved.status).send({ message: resolved.error })
      const { mess, messId, activeMembers } = resolved

      const post = await messPostCollections.findOne({ _id: postId })
      if (!post) return res.status(404).send({ message: 'Post not found.' })
      if (post.messId.toString() !== messId.toString()) return res.status(403).send({ message: 'This post does not belong to your mess.' })

      const postStatus = status === 'published' ? 'published' : (status === 'draft' ? 'draft' : post.status)
      const seats = advertisedSeats !== undefined ? Number(advertisedSeats) : post.advertisedSeats
      const availableSeats = Math.max(0, mess.maxMembers - activeMembers)

      if (postStatus === 'published') {
        const finalTitle = (title !== undefined ? title?.trim() : post.title)
        const finalDesc  = (description !== undefined ? description?.trim() : post.description)
        const finalImages = images !== undefined ? images : post.images
        if (!finalTitle) return res.status(400).send({ message: 'Title is required to publish.' })
        if (!finalDesc)  return res.status(400).send({ message: 'Description is required to publish.' })
        if (!finalImages || finalImages.length === 0) return res.status(400).send({ message: 'At least one image is required to publish.' })
        if (availableSeats <= 0) return res.status(400).send({ message: 'No available seats to advertise.' })
        if (seats < 1 || seats > availableSeats) return res.status(400).send({ message: `Advertised seats must be between 1 and ${availableSeats}.` })
      } else if (seats > 0 && seats > availableSeats) {
        return res.status(400).send({ message: `Advertised seats cannot exceed available seats (${availableSeats}).` })
      }

      const updates = { updatedAt: new Date(), status: postStatus }
      if (title !== undefined)                 updates.title = title?.trim() || ''
      if (description !== undefined)           updates.description = description?.trim() || ''
      if (advertisedSeats !== undefined)       updates.advertisedSeats = seats
      if (messType !== undefined)              updates.messType = messType
      if (roomType !== undefined)              updates.roomType = roomType
      if (foodSystem !== undefined)            updates.foodSystem = foodSystem
      if (facilities !== undefined)            updates.facilities = Array.isArray(facilities) ? facilities : []
      if (approximateMonthlyCost !== undefined) updates.approximateMonthlyCost = Number(approximateMonthlyCost) || 0
      if (rent !== undefined)                  updates.rent = Number(rent) || 0
      if (additionalCost !== undefined)        updates.additionalCost = Number(additionalCost) || 0
      if (costNote !== undefined)              updates.costNote = costNote?.trim() || ''
      if (images !== undefined)                updates.images = Array.isArray(images) ? images : []
      if (preferredMemberTypes !== undefined)  updates.preferredMemberTypes = Array.isArray(preferredMemberTypes) ? preferredMemberTypes : []
      if (additionalInformation !== undefined) updates.additionalInformation = additionalInformation?.trim() || ''

      await messPostCollections.updateOne({ _id: postId }, { $set: updates })
      return res.send({ success: true, status: postStatus })
    })

    // DELETE /mess-posts/:id — delete a post
    app.delete('/mess-posts/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      let postId
      try { postId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid post ID.' }) }

      const resolved = await resolveManagerMess(email)
      if (resolved.error) return res.status(resolved.status).send({ message: resolved.error })
      const { messId } = resolved

      const post = await messPostCollections.findOne({ _id: postId })
      if (!post) return res.status(404).send({ message: 'Post not found.' })
      if (post.messId.toString() !== messId.toString()) return res.status(403).send({ message: 'This post does not belong to your mess.' })

      await messPostCollections.deleteOne({ _id: postId })
      return res.send({ success: true, message: 'Post deleted.' })
    })

    // GET /public-mess-posts — public browsing endpoint (no auth required)
    app.get('/public-mess-posts', async (req, res) => {
      const {
        q = '',
        area = '', city = '',
        messType = '', roomType = '', foodSystem = '',
        minCost = '', maxCost = '',
        minSeats = '',
        facilities = '',
        preferredMemberType = '',
        sort = 'newest',
        page = '1', limit = '12',
      } = req.query

      const pageNum  = Math.max(1, parseInt(page) || 1)
      const limitNum = Math.min(24, Math.max(1, parseInt(limit) || 12))
      const skip = (pageNum - 1) * limitNum

      // Validate sort value
      const validSorts = ['newest', 'lowest_cost', 'available_seats']
      const safeSort = validSorts.includes(sort) ? sort : 'newest'

      const pipeline = [
        // 1 — only published posts
        { $match: { status: 'published' } },

        // 2 — join mess data
        {
          $lookup: {
            from: 'messes',
            localField: 'messId',
            foreignField: '_id',
            as: 'messData',
          },
        },
        { $unwind: { path: '$messData', preserveNullAndEmptyArrays: false } },

        // 3 — only active messes
        { $match: { 'messData.status': 'active' } },

        // 4 — count active members for this mess
        {
          $lookup: {
            from: 'messMembers',
            let: { mid: '$messId' },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ['$messId', '$$mid'] }, { $eq: ['$status', 'active'] }] } } },
              { $count: 'count' },
            ],
            as: 'memberCount',
          },
        },
        {
          $addFields: {
            activeMembers: { $ifNull: [{ $arrayElemAt: ['$memberCount.count', 0] }, 0] },
          },
        },
        {
          $addFields: {
            actualAvailableSeats: {
              $max: [0, { $subtract: ['$messData.maxMembers', '$activeMembers'] }],
            },
          },
        },

        // 5 — only posts with actual available seats AND advertisedSeats > 0
        // advertisedSeats must also be <= actualAvailableSeats (enforced at creation, double-check here)
        { $match: { actualAvailableSeats: { $gt: 0 }, advertisedSeats: { $gt: 0 } } },
        { $match: { $expr: { $lte: ['$advertisedSeats', '$actualAvailableSeats'] } } },

        // 6 — text search across mess name and location
        ...(q ? [{
          $match: {
            $or: [
              { 'messData.name':             { $regex: q, $options: 'i' } },
              { 'messData.location.area':    { $regex: q, $options: 'i' } },
              { 'messData.location.city':    { $regex: q, $options: 'i' } },
              { 'messData.location.address': { $regex: q, $options: 'i' } },
              { title:                        { $regex: q, $options: 'i' } },
            ],
          },
        }] : []),

        // 7 — location filters
        ...(area ? [{ $match: { 'messData.location.area': { $regex: area, $options: 'i' } } }] : []),
        ...(city ? [{ $match: { 'messData.location.city': { $regex: city, $options: 'i' } } }] : []),

        // 8 — type filters
        ...(messType ? [{ $match: { messType } }] : []),
        ...(roomType ? [{ $match: { roomType } }] : []),
        ...(foodSystem ? [{ $match: { foodSystem } }] : []),

        // 9 — budget filter
        ...(minCost ? [{ $match: { approximateMonthlyCost: { $gte: Number(minCost) } } }] : []),
        ...(maxCost ? [{ $match: { approximateMonthlyCost: { $lte: Number(maxCost) } } }] : []),

        // 10 — minimum seats filter uses advertisedSeats (public recruitment value)
        ...(minSeats ? [{ $match: { advertisedSeats: { $gte: Number(minSeats) } } }] : []),

        // 11 — facilities filter (all selected must be present)
        ...(facilities ? (() => {
          const list = facilities.split(',').map(f => f.trim()).filter(Boolean)
          return list.length ? [{ $match: { facilities: { $all: list } } }] : []
        })() : []),

        // 12 — preferred member type
        ...(preferredMemberType ? [{ $match: { preferredMemberTypes: preferredMemberType } }] : []),

        // 13 — project public fields only
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            advertisedSeats: 1,
            messType: 1,
            roomType: 1,
            foodSystem: 1,
            facilities: 1,
            approximateMonthlyCost: 1,
            rent: 1,
            additionalCost: 1,
            costNote: 1,
            images: 1,
            preferredMemberTypes: 1,
            additionalInformation: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            activeMembers: 1,
            actualAvailableSeats: 1,
            mess: {
              _id: '$messData._id',
              name: '$messData.name',
              maxMembers: '$messData.maxMembers',
              location: {
                address: '$messData.location.address',
                area: '$messData.location.area',
                city: '$messData.location.city',
                cityCorporation: '$messData.location.cityCorporation',
                latitude: '$messData.location.latitude',
                longitude: '$messData.location.longitude',
              },
            },
          },
        },
      ]

      // Sort stage
      const sortStage = {
        newest:         { $sort: { updatedAt: -1 } },
        lowest_cost:    { $sort: { approximateMonthlyCost: 1, updatedAt: -1 } },
        available_seats:{ $sort: { advertisedSeats: -1, updatedAt: -1 } },
      }[safeSort]

      const [countResult, data] = await Promise.all([
        messPostCollections.aggregate([...pipeline, { $count: 'total' }]).toArray(),
        messPostCollections.aggregate([...pipeline, sortStage, { $skip: skip }, { $limit: limitNum }]).toArray(),
      ])

      const total = countResult[0]?.total ?? 0

      return res.send({
        data,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      })
    })

    // GET /public-mess-posts/:id — single published post for the public details page
    app.get('/public-mess-posts/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      let postId
      try { postId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid post ID.' }) }

      const post = await messPostCollections.findOne({ _id: postId, status: 'published' })
      if (!post) return res.status(404).send({ message: 'Post not found or not published.' })

      const mess = await messCollections.findOne({ _id: post.messId })
      if (!mess || mess.status !== 'active') return res.status(404).send({ message: 'Mess not found.' })

      const activeMembers = await messMemberCollections.countDocuments({ messId: mess._id, status: 'active' })
      const actualAvailableSeats = Math.max(0, mess.maxMembers - activeMembers)

      // Find the active manager of this mess
      const managerMembership = await messMemberCollections.findOne(
        { messId: mess._id, role: 'manager', status: 'active' },
        { sort: { joinedAt: -1 } }
      )
      let manager = null
      if (managerMembership) {
        const managerUser = await userCollections.findOne({ _id: managerMembership.userId })
        if (managerUser) {
          manager = {
            name: managerUser.name || '',
            email: managerUser.email || '',
            phone: managerUser.phone || '',
            photoURL: managerUser.photoURL || '',
          }
        }
      }

      return res.send({
        _id: post._id,
        title: post.title,
        description: post.description,
        advertisedSeats: post.advertisedSeats,
        messType: post.messType,
        roomType: post.roomType,
        foodSystem: post.foodSystem,
        facilities: post.facilities,
        approximateMonthlyCost: post.approximateMonthlyCost,
        rent: post.rent,
        additionalCost: post.additionalCost,
        costNote: post.costNote,
        images: post.images,
        preferredMemberTypes: post.preferredMemberTypes,
        additionalInformation: post.additionalInformation,
        status: post.status,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        mess: {
          _id: mess._id,
          name: mess.name,
          description: mess.description,
          location: {
            address: mess.location?.address || '',
            area: mess.location?.area || '',
            city: mess.location?.city || '',
            cityCorporation: mess.location?.cityCorporation || '',
            latitude: mess.location?.latitude,
            longitude: mess.location?.longitude,
          },
          maxMembers: mess.maxMembers,
        },
        activeMembers,
        actualAvailableSeats,
        manager,
      })
    })

    // PATCH /messes/:id/regenerate-code — generate a new unique messCode for this mess
    // Only the active manager of the mess may do this.
    // Existing messMembers and joinRequests are unaffected; the old code simply stops matching.
    app.patch('/messes/:id/regenerate-code', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.body
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id, messId: messObjectId, role: 'manager', status: 'active',
      })
      if (!membership) return res.status(403).send({ message: 'You are not the manager of this mess.' })

      try {
        const newCode = await generateUniqueMessCode()
        await messCollections.updateOne(
          { _id: messObjectId },
          { $set: { messCode: newCode, updatedAt: new Date() } }
        )
        return res.send({ success: true, messCode: newCode })
      } catch (err) {
        console.error('Error regenerating mess code:', err)
        return res.status(500).send({ message: 'Could not generate a unique mess code. Please try again.' })
      }
    })

    // ── Meals ─────────────────────────────────────────────────────────────────

    // Unique index: one meal document per mess per day
    try {
      await mealCollections.createIndex({ messId: 1, date: 1 }, { unique: true })
      console.log('Unique index on meals (messId, date) ensured.')
    } catch (idxErr) {
      console.warn('Could not create meals index (non-fatal):', idxErr.message)
    }

    // Bazar collection indexes
    try {
      await bazarCollections.createIndex({ messId: 1, date: -1 })
      await bazarCollections.createIndex({ messId: 1, status: 1 })
      console.log('Indexes on bazar collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create bazar indexes (non-fatal):', idxErr.message)
    }

    // Bazar assignments collection indexes
    try {
      await bazarAssignmentsCollections.createIndex({ messId: 1, assignedTo: 1 })
      await bazarAssignmentsCollections.createIndex({ messId: 1, status: 1 })
      console.log('Indexes on bazarAssignments collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create bazarAssignments indexes (non-fatal):', idxErr.message)
    }

    // Khalabill collection indexes
    try {
      await khalabillCollections.createIndex({ messId: 1, month: 1 }, { unique: true })
      console.log('Indexes on khalabill collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create khalabill indexes (non-fatal):', idxErr.message)
    }

    // Common expenses collection indexes
    try {
      await commonExpensesCollections.createIndex({ messId: 1, date: -1 })
      console.log('Indexes on commonExpenses collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create commonExpenses indexes (non-fatal):', idxErr.message)
    }

    // Member rent collection indexes
    try {
      await memberRentCollections.createIndex({ messId: 1, month: 1, userId: 1 }, { unique: true })
      console.log('Indexes on memberRent collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create memberRent indexes (non-fatal):', idxErr.message)
    }

    // Payments collection indexes
    try {
      await paymentsCollections.createIndex({ messId: 1, date: -1 })
      await paymentsCollections.createIndex({ messId: 1, userId: 1 })
      await paymentsCollections.createIndex({ messId: 1, category: 1 })
      console.log('Indexes on payments collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create payments indexes (non-fatal):', idxErr.message)
    }

    // Monthly reports collection indexes
    try {
      await monthlyReportsCollections.createIndex({ messId: 1, month: 1 }, { unique: true })
      await monthlyReportsCollections.createIndex({ messId: 1, closedAt: -1 })
      console.log('Indexes on monthlyReports collection ensured.')
    } catch (idxErr) {
      console.warn('Could not create monthlyReports indexes (non-fatal):', idxErr.message)
    }

    // Normalise a date string to a UTC midnight Date for consistent storage and querying
    const toMidnightUTC = (dateStr) => {
      // dateStr expected as YYYY-MM-DD (Asia/Dhaka local date chosen by the manager)
      const [y, m, d] = dateStr.split('-').map(Number)
      return new Date(Date.UTC(y, m - 1, d))
    }

    const VALID_MEAL_VALUES = new Set([0, 0.5, 1])

    // Helper function to validate guest meal values (multiples of 0.5)
    const isValidGuestMeal = (val) => {
      const num = Number(val)
      if (isNaN(num) || num < 0) return false
      // Check if it's a multiple of 0.5
      return Math.abs((num * 2) % 1) < 0.001
    }

    // GET /meals/mess/:messId?month=YYYY-MM
    app.get('/meals/mess/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { month } = req.query

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).send({ message: 'month query param is required (YYYY-MM).' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const [year, mon] = month.split('-').map(Number)
      const from = new Date(Date.UTC(year, mon - 1, 1))
      const to   = new Date(Date.UTC(year, mon, 1))   // exclusive upper bound

      const docs = await mealCollections
        .find({ messId: messObjectId, date: { $gte: from, $lt: to } })
        .sort({ date: 1 })
        .toArray()

      return res.send(docs)
    })

    // GET /meals/mess/:messId/date/:date  — date as YYYY-MM-DD
    app.get('/meals/mess/:messId/date/:date', async (req, res) => {
      const { ObjectId } = require('mongodb')

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const dateStr = req.params.date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).send({ message: 'date must be YYYY-MM-DD.' })
      }

      const day = toMidnightUTC(dateStr)
      const doc = await mealCollections.findOne({ messId: messObjectId, date: day })
      return res.send({ meal: doc || null })
    })

    // PUT /meals/mess/:messId/date/:date  — create or replace the day's meal record
    app.put('/meals/mess/:messId/date/:date', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, entries } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!Array.isArray(entries)) return res.status(400).send({ message: 'entries must be an array.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const dateStr = req.params.date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).send({ message: 'date must be YYYY-MM-DD.' })
      }

      // Validate date: must be current month, cannot be future
      const [reqYear, reqMonth, reqDay] = dateStr.split('-').map(Number)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1  // 1-indexed
      const currentDay = now.getDate()

      // Reject if not current month
      if (reqYear !== currentYear || reqMonth !== currentMonth) {
        return res.status(400).send({ message: 'Meals can only be updated for the current month.' })
      }

      // Reject if future date
      if (reqDay > currentDay) {
        return res.status(400).send({ message: 'Future meal dates cannot be updated.' })
      }

      // Verify caller is active manager of this mess
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id, messId: messObjectId, role: 'manager', status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      // Check if month is closed
      const monthStr = `${reqYear}-${String(reqMonth).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      // Load active members to validate submitted userIds
      const activeMembers = await messMemberCollections
        .find({ messId: messObjectId, status: 'active' })
        .toArray()
      const activeMemberIdSet = new Set(activeMembers.map(m => m.userId.toString()))

      // Validate entries
      for (const entry of entries) {
        if (!entry.userId) return res.status(400).send({ message: 'Each entry must have userId.' })

        let entryUserId
        try { entryUserId = new ObjectId(entry.userId) }
        catch { return res.status(400).send({ message: `Invalid userId: ${entry.userId}` }) }

        if (!activeMemberIdSet.has(entryUserId.toString())) {
          return res.status(400).send({ message: `userId ${entry.userId} is not an active member.` })
        }

        for (const slot of ['breakfast', 'lunch', 'dinner']) {
          const val = Number(entry[slot] ?? 0)
          if (!VALID_MEAL_VALUES.has(val)) {
            return res.status(400).send({
              message: `Invalid value ${entry[slot]} for ${slot}. Allowed: 0, 0.5, 1.`,
            })
          }
        }

        // Validate guestMeal - must be non-negative and multiple of 0.5
        if (entry.guestMeal !== undefined) {
          const guestMealVal = Number(entry.guestMeal ?? 0)
          if (!isValidGuestMeal(guestMealVal)) {
            return res.status(400).send({
              message: `Invalid guestMeal value ${entry.guestMeal}. Must be non-negative and a multiple of 0.5.`,
            })
          }
        }
      }

      // Build normalised entries — only store ObjectId userId + meal slot numbers
      const cleanEntries = entries.map(e => ({
        userId:    new ObjectId(e.userId),
        breakfast: Number(e.breakfast ?? 0),
        lunch:     Number(e.lunch     ?? 0),
        dinner:    Number(e.dinner    ?? 0),
        guestMeal: Number(e.guestMeal ?? 0),
      }))

      const day = toMidnightUTC(dateStr)
      const timestamp = new Date()

      await mealCollections.updateOne(
        { messId: messObjectId, date: day },
        {
          $set:         { entries: cleanEntries, updatedAt: timestamp, messId: messObjectId, date: day },
          $setOnInsert: { createdAt: timestamp },
        },
        { upsert: true }
      )

      // Notify affected members about meal update
      const displayDateStr = day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      for (const entry of cleanEntries) {
        // Only notify if there's actual meal data (not all zeros)
        const hasMealData = entry.breakfast > 0 || entry.lunch > 0 || entry.dinner > 0 || entry.guestMeal > 0
        if (hasMealData) {
          await createNotification({
            userId: entry.userId,
            messId: messObjectId,
            type: 'meal_updated',
            title: 'Meal Updated',
            message: `Your meal for ${displayDateStr} has been updated.`,
            link: '/dashboard/my-meals'
          })
        }
      }

      const updated = await mealCollections.findOne({ messId: messObjectId, date: day })
      return res.send({ success: true, meal: updated })
    })

    // ═══════════════════════════════════════════════════════════════════════════
    //  BAZAR MANAGEMENT API
    // ═══════════════════════════════════════════════════════════════════════════

    // GET /bazar/mess/:messId — Get all bazar records for a mess (with optional status filter)
    app.get('/bazar/mess/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { status, month } = req.query

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const query = { messId: messObjectId }
      
      if (status) {
        query.status = status
      }

      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const [year, mon] = month.split('-').map(Number)
        const from = new Date(Date.UTC(year, mon - 1, 1))
        const to = new Date(Date.UTC(year, mon, 1))
        query.date = { $gte: from, $lt: to }
      }

      try {
        const records = await bazarCollections
          .find(query)
          .sort({ date: -1 })
          .toArray()

        // Populate buyer information
        for (const record of records) {
          if (record.buyerId) {
            const buyer = await userCollections.findOne(
              { _id: record.buyerId },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            record.buyer = buyer
          }
        }

        return res.send({ records })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch bazar records.' })
      }
    })

    // POST /bazar/mess/:messId — Manager creates official bazar
    app.post('/bazar/mess/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, date, buyerId, items, note, source } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!date) return res.status(400).send({ message: 'date is required.' })
      if (!buyerId) return res.status(400).send({ message: 'buyerId is required.' })
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).send({ message: 'items array is required.' })
      }

      let messObjectId, buyerObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }
      try { buyerObjectId = new ObjectId(buyerId) }
      catch { return res.status(400).send({ message: 'Invalid buyer ID.' }) }

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      // Validate items
      for (const item of items) {
        if (!item.name?.trim()) {
          return res.status(400).send({ message: 'Item name is required.' })
        }
        if (!item.quantity || item.quantity <= 0) {
          return res.status(400).send({ message: 'Item quantity must be positive.' })
        }
        if (!item.amount || item.amount < 0) {
          return res.status(400).send({ message: 'Item amount must be non-negative.' })
        }
      }

      // Calculate total amount from items
      const totalAmount = items.reduce((sum, item) => sum + Number(item.amount), 0)

      const bazarDate = toMidnightUTC(date)
      const now = new Date()

      const newBazar = {
        messId: messObjectId,
        date: bazarDate,
        buyerId: buyerObjectId,
        source: source || 'manager',
        assignmentId: null,
        status: 'approved',
        items: items.map(item => ({
          name: item.name.trim(),
          quantity: Number(item.quantity),
          unit: item.unit?.trim() || '',
          amount: Number(item.amount),
        })),
        totalAmount,
        note: note?.trim() || '',
        rejectionReason: '',
        createdAt: now,
        updatedAt: now,
      }

      try {
        const result = await bazarCollections.insertOne(newBazar)
        return res.send({ success: true, id: result.insertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to create bazar.' })
      }
    })

    // PUT /bazar/:id — Manager edits approved bazar
    app.put('/bazar/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, date, buyerId, items, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let bazarObjectId
      try { bazarObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid bazar ID.' }) }

      // Find existing bazar
      const existing = await bazarCollections.findOne({ _id: bazarObjectId })
      if (!existing) return res.status(404).send({ message: 'Bazar not found.' })

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      // Build update
      const update = { updatedAt: new Date() }

      if (date) update.date = toMidnightUTC(date)
      if (buyerId) {
        try { update.buyerId = new ObjectId(buyerId) }
        catch { return res.status(400).send({ message: 'Invalid buyer ID.' }) }
      }
      if (items && Array.isArray(items)) {
        for (const item of items) {
          if (!item.name?.trim()) {
            return res.status(400).send({ message: 'Item name is required.' })
          }
          if (!item.quantity || item.quantity <= 0) {
            return res.status(400).send({ message: 'Item quantity must be positive.' })
          }
          if (item.amount < 0) {
            return res.status(400).send({ message: 'Item amount must be non-negative.' })
          }
        }
        update.items = items.map(item => ({
          name: item.name.trim(),
          quantity: Number(item.quantity),
          unit: item.unit?.trim() || '',
          amount: Number(item.amount),
        }))
        update.totalAmount = items.reduce((sum, item) => sum + Number(item.amount), 0)
      }
      if (note !== undefined) update.note = note.trim()

      try {
        await bazarCollections.updateOne({ _id: bazarObjectId }, { $set: update })
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to update bazar.' })
      }
    })

    // DELETE /bazar/:id — Manager deletes bazar
    app.delete('/bazar/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let bazarObjectId
      try { bazarObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid bazar ID.' }) }

      const existing = await bazarCollections.findOne({ _id: bazarObjectId })
      if (!existing) return res.status(404).send({ message: 'Bazar not found.' })

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      try {
        await bazarCollections.deleteOne({ _id: bazarObjectId })
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to delete bazar.' })
      }
    })

    // POST /bazar/mess/:messId/assign — Manager creates bazar assignment
    app.post('/bazar/mess/:messId/assign', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, assignedTo, date, items, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!assignedTo) return res.status(400).send({ message: 'assignedTo is required.' })
      if (!date) return res.status(400).send({ message: 'date is required.' })
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).send({ message: 'items array is required.' })
      }

      let messObjectId, assignedToObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }
      try { assignedToObjectId = new ObjectId(assignedTo) }
      catch { return res.status(400).send({ message: 'Invalid assignedTo ID.' }) }

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      // Verify assignedTo is active member
      const memberMembership = await messMemberCollections.findOne({
        userId: assignedToObjectId,
        messId: messObjectId,
        status: 'active',
      })
      if (!memberMembership) {
        return res.status(400).send({ message: 'Assigned user is not an active member.' })
      }

      // Check if month is closed
      const assignmentDate = toMidnightUTC(date)
      const dateObj = new Date(assignmentDate)
      const monthStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      const now = new Date()

      const newAssignment = {
        messId: messObjectId,
        assignedTo: assignedToObjectId,
        assignedBy: caller._id,
        date: assignmentDate,
        items: items.map(item => ({
          name: item.name?.trim() || '',
          quantity: Number(item.quantity || 0),
          unit: item.unit?.trim() || '',
        })),
        note: note?.trim() || '',
        status: 'assigned',
        createdAt: now,
        updatedAt: now,
      }

      try {
        const result = await bazarAssignmentsCollections.insertOne(newAssignment)
        
        // Notify assigned member
        const assignedUser = await userCollections.findOne({ _id: assignedToObjectId })
        const dateStr = assignmentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        await createNotification({
          userId: assignedToObjectId,
          messId: messObjectId,
          type: 'bazar_assignment',
          title: 'New Bazar Assignment',
          message: `You have been assigned bazar for ${dateStr}.`,
          link: '/dashboard/my-bazar'
        })
        
        return res.send({ success: true, id: result.insertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to create assignment.' })
      }
    })

    // GET /bazar/assignments/mess/:messId — Get all assignments for a mess
    app.get('/bazar/assignments/mess/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      try {
        const assignments = await bazarAssignmentsCollections
          .find({ messId: messObjectId })
          .sort({ date: -1 })
          .toArray()

        // Populate assigned user and manager info
        for (const assignment of assignments) {
          if (assignment.assignedTo) {
            const assignedUser = await userCollections.findOne(
              { _id: assignment.assignedTo },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            assignment.assignedUser = assignedUser
          }
          if (assignment.assignedBy) {
            const manager = await userCollections.findOne(
              { _id: assignment.assignedBy },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            assignment.manager = manager
          }
        }

        return res.send({ assignments })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch assignments.' })
      }
    })

    // GET /bazar/assignments/my — Get assignments for logged-in member
    app.get('/bazar/assignments/my', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      try {
        const assignments = await bazarAssignmentsCollections
          .find({ assignedTo: caller._id })
          .sort({ date: -1 })
          .toArray()

        // Populate manager info
        for (const assignment of assignments) {
          if (assignment.assignedBy) {
            const manager = await userCollections.findOne(
              { _id: assignment.assignedBy },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            assignment.manager = manager
          }
        }

        return res.send({ assignments })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch assignments.' })
      }
    })

    // PUT /bazar/assignments/:id — Manager updates assignment
    app.put('/bazar/assignments/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, assignedTo, date, items, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let assignmentObjectId
      try { assignmentObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid assignment ID.' }) }

      const existing = await bazarAssignmentsCollections.findOne({ _id: assignmentObjectId })
      if (!existing) return res.status(404).send({ message: 'Assignment not found.' })

      // Only allow modification if status is 'assigned'
      if (existing.status !== 'assigned') {
        return res.status(400).send({ message: 'Only assignments with "assigned" status can be modified.' })
      }

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      const update = { updatedAt: new Date() }

      if (assignedTo) {
        let assignedToObjectId
        try { assignedToObjectId = new ObjectId(assignedTo) }
        catch { return res.status(400).send({ message: 'Invalid assignedTo ID.' }) }
        
        // Verify new assignee is active member
        const memberMembership = await messMemberCollections.findOne({
          userId: assignedToObjectId,
          messId: existing.messId,
          status: 'active',
        })
        if (!memberMembership) {
          return res.status(400).send({ message: 'Assigned user is not an active member.' })
        }
        update.assignedTo = assignedToObjectId
      }

      if (date) update.date = toMidnightUTC(date)
      
      if (items && Array.isArray(items)) {
        update.items = items.map(item => ({
          name: item.name?.trim() || '',
          quantity: Number(item.quantity || 0),
          unit: item.unit?.trim() || '',
        }))
      }

      if (note !== undefined) update.note = note.trim()

      try {
        await bazarAssignmentsCollections.updateOne({ _id: assignmentObjectId }, { $set: update })
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to update assignment.' })
      }
    })

    // PUT /bazar/assignments/:id/cancel — Manager cancels assignment
    app.put('/bazar/assignments/:id/cancel', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let assignmentObjectId
      try { assignmentObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid assignment ID.' }) }

      const existing = await bazarAssignmentsCollections.findOne({ _id: assignmentObjectId })
      if (!existing) return res.status(404).send({ message: 'Assignment not found.' })

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      try {
        await bazarAssignmentsCollections.updateOne(
          { _id: assignmentObjectId },
          { $set: { status: 'cancelled', updatedAt: new Date() } }
        )
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to cancel assignment.' })
      }
    })

    // DELETE /bazar/assignments/:id — Manager cancels assignment
    app.delete('/bazar/assignments/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let assignmentObjectId
      try { assignmentObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid assignment ID.' }) }

      const existing = await bazarAssignmentsCollections.findOne({ _id: assignmentObjectId })
      if (!existing) return res.status(404).send({ message: 'Assignment not found.' })

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      try {
        await bazarAssignmentsCollections.deleteOne({ _id: assignmentObjectId })
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to delete assignment.' })
      }
    })

    // POST /bazar/mess/:messId/submit — Member submits bazar (creates pending record)
    app.post('/bazar/mess/:messId/submit', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, date, items, note, assignmentId } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!date) return res.status(400).send({ message: 'date is required.' })
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).send({ message: 'items array is required.' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      // Verify caller is active member
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not an active member of this mess.' })
      }

      // Check if month is closed
      const bazarDate = toMidnightUTC(date)
      const dateObj = new Date(bazarDate)
      const monthStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      // Validate items
      for (const item of items) {
        if (!item.name?.trim()) {
          return res.status(400).send({ message: 'Item name is required.' })
        }
        if (!item.quantity || item.quantity <= 0) {
          return res.status(400).send({ message: 'Item quantity must be positive.' })
        }
        if (item.amount < 0) {
          return res.status(400).send({ message: 'Item amount must be non-negative.' })
        }
      }

      const totalAmount = items.reduce((sum, item) => sum + Number(item.amount), 0)
      const now = new Date()

      const newBazar = {
        messId: messObjectId,
        date: bazarDate,
        buyerId: caller._id,
        source: assignmentId ? 'assigned' : 'member',
        assignmentId: assignmentId ? new ObjectId(assignmentId) : null,
        status: 'pending',
        items: items.map(item => ({
          name: item.name.trim(),
          quantity: Number(item.quantity),
          unit: item.unit?.trim() || '',
          amount: Number(item.amount),
        })),
        totalAmount,
        note: note?.trim() || '',
        rejectionReason: '',
        createdAt: now,
        updatedAt: now,
      }

      try {
        const result = await bazarCollections.insertOne(newBazar)
        
        // Update assignment status if applicable
        if (assignmentId) {
          await bazarAssignmentsCollections.updateOne(
            { _id: new ObjectId(assignmentId) },
            { $set: { status: 'submitted', updatedAt: now } }
          )
        }

        // Notify manager about bazar submission
        const manager = await messMemberCollections.findOne({ messId: messObjectId, role: 'manager', status: 'active' })
        if (manager) {
          const mess = await messCollections.findOne({ _id: messObjectId })
          const dateStr = bazarDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          await createNotification({
            userId: manager.userId,
            messId: messObjectId,
            type: 'bazar_submitted',
            title: 'Bazar Submitted',
            message: `${caller.name || 'A member'} submitted bazar for ${dateStr}.`,
            link: '/dashboard/monthly/bazar'
          })
        }

        return res.send({ success: true, id: result.insertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to submit bazar.' })
      }
    })

    // PUT /bazar/:id/approve — Manager approves pending bazar
    app.put('/bazar/:id/approve', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let bazarObjectId
      try { bazarObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid bazar ID.' }) }

      const existing = await bazarCollections.findOne({ _id: bazarObjectId })
      if (!existing) return res.status(404).send({ message: 'Bazar not found.' })

      if (existing.status !== 'pending') {
        return res.status(400).send({ message: 'Only pending bazar can be approved.' })
      }

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      // Check if month is closed
      const dateObj = new Date(existing.date)
      const monthStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: existing.messId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        await bazarCollections.updateOne(
          { _id: bazarObjectId },
          { $set: { status: 'approved', updatedAt: new Date() } }
        )
        
        // Notify member about approval
        await createNotification({
          userId: existing.buyerId,
          messId: existing.messId,
          type: 'bazar_approved',
          title: 'Bazar Approved',
          message: 'Your bazar submission has been approved by the manager.',
          link: '/dashboard/my-bazar'
        })

        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to approve bazar.' })
      }
    })

    // PUT /bazar/:id/reject — Manager rejects pending bazar
    app.put('/bazar/:id/reject', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, reason } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let bazarObjectId
      try { bazarObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid bazar ID.' }) }

      const existing = await bazarCollections.findOne({ _id: bazarObjectId })
      if (!existing) return res.status(404).send({ message: 'Bazar not found.' })

      if (existing.status !== 'pending') {
        return res.status(400).send({ message: 'Only pending bazar can be rejected.' })
      }

      // Verify caller is manager
      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'You are not the manager of this mess.' })
      }

      // Check if month is closed
      const dateObj = new Date(existing.date)
      const monthStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: existing.messId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        await bazarCollections.updateOne(
          { _id: bazarObjectId },
          { 
            $set: { 
              status: 'rejected', 
              rejectionReason: reason?.trim() || 'No reason provided',
              updatedAt: new Date() 
            } 
          }
        )
        
        // Notify member about rejection
        const rejectionMsg = reason?.trim() ? `Reason: ${reason.trim()}` : 'Your bazar submission was rejected by the manager.'
        await createNotification({
          userId: existing.buyerId,
          messId: existing.messId,
          type: 'bazar_rejected',
          title: 'Bazar Rejected',
          message: rejectionMsg,
          link: '/dashboard/my-bazar'
        })

        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to reject bazar.' })
      }
    })

    // GET /bazar/my-history — Member gets own bazar history
    app.get('/bazar/my-history', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, messId } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!messId) return res.status(400).send({ message: 'messId is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      try {
        const records = await bazarCollections
          .find({ 
            messId: messObjectId,
            buyerId: caller._id
          })
          .sort({ date: -1 })
          .toArray()

        return res.send({ records })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch history.' })
      }
    })

    // ========================================
    // EXPENSES MANAGEMENT APIs
    // ========================================

    // GET /expenses/khalabill/:messId — Get current month khalabill
    app.get('/expenses/khalabill/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Get current month in YYYY-MM format (Asia/Dhaka)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

      try {
        const khalabill = await khalabillCollections.findOne({
          messId: messObjectId,
          month: currentMonth
        })

        // Get active member count
        const activeMemberCount = await messMemberCollections.countDocuments({
          messId: messObjectId,
          status: 'active'
        })

        return res.send({
          khalabill: khalabill || null,
          activeMemberCount,
          perMember: khalabill && activeMemberCount > 0 
            ? khalabill.amount / activeMemberCount 
            : 0
        })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch khalabill.' })
      }
    })

    // POST /expenses/khalabill/:messId — Create/update khalabill
    app.post('/expenses/khalabill/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, amount, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (amount === undefined || amount === null) {
        return res.status(400).send({ message: 'amount is required.' })
      }

      const numAmount = Number(amount)
      if (isNaN(numAmount) || numAmount < 0) {
        return res.status(400).send({ message: 'amount must be a valid non-negative number.' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can set khalabill.' })
      }

      // Get current month
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

      // Check if month is closed
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: currentMonth
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        const result = await khalabillCollections.updateOne(
          { messId: messObjectId, month: currentMonth },
          {
            $set: {
              amount: numAmount,
              note: note?.trim() || '',
              updatedBy: caller._id,
              updatedAt: new Date()
            },
            $setOnInsert: {
              messId: messObjectId,
              month: currentMonth,
              createdBy: caller._id,
              createdAt: new Date()
            }
          },
          { upsert: true }
        )
        return res.send({ success: true, upsertedId: result.upsertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to save khalabill.' })
      }
    })

    // GET /expenses/common/:messId — Get current month common expenses
    app.get('/expenses/common/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Get current month date range
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const year = now.getFullYear()
      const month = now.getMonth()
      const startDate = new Date(Date.UTC(year, month, 1))
      const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))

      try {
        const expenses = await commonExpensesCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lte: endDate }
          })
          .sort({ date: -1 })
          .toArray()

        // Populate creator info
        const expensesWithCreator = await Promise.all(
          expenses.map(async (exp) => {
            const creator = await userCollections.findOne(
              { _id: exp.createdBy },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            return { ...exp, creator }
          })
        )

        const total = expenses.reduce((sum, exp) => sum + exp.amount, 0)

        return res.send({ expenses: expensesWithCreator, total })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch expenses.' })
      }
    })

    // GET /expenses/common/single/:id — Get single expense details
    app.get('/expenses/common/single/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let expenseObjectId
      try { expenseObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid expense ID.' }) }

      const expense = await commonExpensesCollections.findOne({ _id: expenseObjectId })
      if (!expense) return res.status(404).send({ message: 'Expense not found.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: expense.messId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Populate creator info
      const creator = await userCollections.findOne(
        { _id: expense.createdBy },
        { projection: { name: 1, email: 1, photoURL: 1 } }
      )

      return res.send({ expense: { ...expense, creator } })
    })

    // POST /expenses/common/:messId — Create common expense
    app.post('/expenses/common/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, date, category, amount, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!date) return res.status(400).send({ message: 'date is required.' })
      if (!category) return res.status(400).send({ message: 'category is required.' })
      if (amount === undefined || amount === null) {
        return res.status(400).send({ message: 'amount is required.' })
      }

      const numAmount = Number(amount)
      if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).send({ message: 'amount must be a positive number.' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can add expenses.' })
      }

      // Validate date is current month
      const [reqYear, reqMonth, reqDay] = date.split('-').map(Number)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1

      if (reqYear !== currentYear || reqMonth !== currentMonth) {
        return res.status(400).send({ message: 'Expenses can only be added for the current month.' })
      }

      // Check if month is closed
      const monthStr = `${reqYear}-${String(reqMonth).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        const expenseDoc = {
          messId: messObjectId,
          date: toMidnightUTC(date),
          category: category.trim(),
          amount: numAmount,
          note: note?.trim() || '',
          createdBy: caller._id,
          createdAt: new Date(),
          updatedAt: new Date()
        }

        const result = await commonExpensesCollections.insertOne(expenseDoc)
        return res.send({ success: true, insertedId: result.insertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to create expense.' })
      }
    })

    // PUT /expenses/common/:id — Update common expense
    app.put('/expenses/common/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, date, category, amount, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let expenseObjectId
      try { expenseObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid expense ID.' }) }

      const existing = await commonExpensesCollections.findOne({ _id: expenseObjectId })
      if (!existing) return res.status(404).send({ message: 'Expense not found.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can edit expenses.' })
      }

      const updates = { updatedAt: new Date() }

      if (date !== undefined) {
        // Validate date is current month
        const [reqYear, reqMonth, reqDay] = date.split('-').map(Number)
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
        const currentYear = now.getFullYear()
        const currentMonth = now.getMonth() + 1

        if (reqYear !== currentYear || reqMonth !== currentMonth) {
          return res.status(400).send({ message: 'Expenses can only be set for the current month.' })
        }
        updates.date = toMidnightUTC(date)
      }

      if (category !== undefined) updates.category = category.trim()
      
      if (amount !== undefined) {
        const numAmount = Number(amount)
        if (isNaN(numAmount) || numAmount <= 0) {
          return res.status(400).send({ message: 'amount must be a positive number.' })
        }
        updates.amount = numAmount
      }

      if (note !== undefined) updates.note = note.trim()

      try {
        await commonExpensesCollections.updateOne(
          { _id: expenseObjectId },
          { $set: updates }
        )
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to update expense.' })
      }
    })

    // DELETE /expenses/common/:id — Delete common expense
    app.delete('/expenses/common/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let expenseObjectId
      try { expenseObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid expense ID.' }) }

      const existing = await commonExpensesCollections.findOne({ _id: expenseObjectId })
      if (!existing) return res.status(404).send({ message: 'Expense not found.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can delete expenses.' })
      }

      try {
        await commonExpensesCollections.deleteOne({ _id: expenseObjectId })
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to delete expense.' })
      }
    })

    // GET /expenses/rent/:messId — Get current month member rents
    app.get('/expenses/rent/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Get current month
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

      try {
        // Get all active members
        const activeMembers = await messMemberCollections
          .find({ messId: messObjectId, status: 'active' })
          .toArray()

        // Get all rents for current month
        const rents = await memberRentCollections
          .find({ messId: messObjectId, month: currentMonth })
          .toArray()

        // Populate member info and merge with rent data
        const membersWithRent = await Promise.all(
          activeMembers.map(async (member) => {
            const user = await userCollections.findOne(
              { _id: member.userId },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            const rent = rents.find(r => r.userId.equals(member.userId))
            return {
              userId: member.userId,
              user,
              role: member.role,
              rent: rent ? rent.amount : null,
              rentId: rent ? rent._id : null,
              lastUpdated: rent ? rent.updatedAt : null
            }
          })
        )

        const totalRent = rents.reduce((sum, r) => sum + r.amount, 0)

        return res.send({ members: membersWithRent, totalRent })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch member rents.' })
      }
    })

    // POST /expenses/rent/:messId — Set/update member rent
    app.post('/expenses/rent/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, userId, amount } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!userId) return res.status(400).send({ message: 'userId is required.' })
      if (amount === undefined || amount === null) {
        return res.status(400).send({ message: 'amount is required.' })
      }

      const numAmount = Number(amount)
      if (isNaN(numAmount) || numAmount < 0) {
        return res.status(400).send({ message: 'amount must be a non-negative number.' })
      }

      let messObjectId, userObjectId
      try { 
        messObjectId = new ObjectId(req.params.messId)
        userObjectId = new ObjectId(userId)
      }
      catch { return res.status(400).send({ message: 'Invalid ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can set rent.' })
      }

      // Verify target user is active member
      const targetMembership = await messMemberCollections.findOne({
        userId: userObjectId,
        messId: messObjectId,
        status: 'active'
      })
      if (!targetMembership) {
        return res.status(400).send({ message: 'User is not an active member of this mess.' })
      }

      // Get current month
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

      // Check if month is closed
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: currentMonth
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        const result = await memberRentCollections.updateOne(
          { messId: messObjectId, month: currentMonth, userId: userObjectId },
          {
            $set: {
              amount: numAmount,
              updatedBy: caller._id,
              updatedAt: new Date()
            },
            $setOnInsert: {
              messId: messObjectId,
              month: currentMonth,
              userId: userObjectId,
              createdAt: new Date()
            }
          },
          { upsert: true }
        )
        return res.send({ success: true, upsertedId: result.upsertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to set rent.' })
      }
    })

    // ========================================
    // PAYMENTS MANAGEMENT APIs
    // ========================================

    // GET /payments/:messId — Get current month payments
    app.get('/payments/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Get current month date range
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const year = now.getFullYear()
      const month = now.getMonth()
      const startDate = new Date(Date.UTC(year, month, 1))
      const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))

      try {
        const payments = await paymentsCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lte: endDate }
          })
          .sort({ date: -1 })
          .toArray()

        // Populate member and creator info
        const paymentsWithInfo = await Promise.all(
          payments.map(async (payment) => {
            const member = await userCollections.findOne(
              { _id: payment.userId },
              { projection: { name: 1, email: 1, photoURL: 1 } }
            )
            const creator = await userCollections.findOne(
              { _id: payment.createdBy },
              { projection: { name: 1, email: 1 } }
            )
            return { ...payment, member, creator }
          })
        )

        // Calculate category-wise totals
        const totals = {
          meal: 0,
          rent: 0,
          khalabill: 0,
          common_expense: 0,
          other: 0,
          total: 0
        }

        payments.forEach(p => {
          totals[p.category] = (totals[p.category] || 0) + p.amount
          totals.total += p.amount
        })

        return res.send({ payments: paymentsWithInfo, totals, count: payments.length })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to fetch payments.' })
      }
    })

    // GET /payments/single/:id — Get single payment details
    app.get('/payments/single/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let paymentObjectId
      try { paymentObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid payment ID.' }) }

      const payment = await paymentsCollections.findOne({ _id: paymentObjectId })
      if (!payment) return res.status(404).send({ message: 'Payment not found.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: payment.messId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Populate member and creator info
      const member = await userCollections.findOne(
        { _id: payment.userId },
        { projection: { name: 1, email: 1, photoURL: 1 } }
      )
      const creator = await userCollections.findOne(
        { _id: payment.createdBy },
        { projection: { name: 1, email: 1 } }
      )

      return res.send({ payment: { ...payment, member, creator } })
    })

    // POST /payments/:messId — Create payment
    app.post('/payments/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, userId, category, amount, date, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!userId) return res.status(400).send({ message: 'userId is required.' })
      if (!category) return res.status(400).send({ message: 'category is required.' })
      if (amount === undefined || amount === null) {
        return res.status(400).send({ message: 'amount is required.' })
      }
      if (!date) return res.status(400).send({ message: 'date is required.' })

      const numAmount = Number(amount)
      if (isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).send({ message: 'amount must be a positive number.' })
      }

      // Validate category
      const validCategories = ['meal', 'rent', 'khalabill', 'common_expense', 'other']
      if (!validCategories.includes(category)) {
        return res.status(400).send({ message: 'Invalid category.' })
      }

      let messObjectId, userObjectId
      try { 
        messObjectId = new ObjectId(req.params.messId)
        userObjectId = new ObjectId(userId)
      }
      catch { return res.status(400).send({ message: 'Invalid ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can record payments.' })
      }

      // Verify payment recipient is active member
      const recipientMembership = await messMemberCollections.findOne({
        userId: userObjectId,
        messId: messObjectId,
        status: 'active'
      })
      if (!recipientMembership) {
        return res.status(400).send({ message: 'Payment recipient is not an active member of this mess.' })
      }

      // Validate date is current month
      const [reqYear, reqMonth, reqDay] = date.split('-').map(Number)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const currentYear = now.getFullYear()
      const currentMonth = now.getMonth() + 1

      if (reqYear !== currentYear || reqMonth !== currentMonth) {
        return res.status(400).send({ message: 'Payments can only be recorded for the current month.' })
      }

      // Check if month is closed
      const monthStr = `${reqYear}-${String(reqMonth).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: messObjectId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        const paymentDoc = {
          messId: messObjectId,
          userId: userObjectId,
          category,
          amount: numAmount,
          date: toMidnightUTC(date),
          note: note?.trim() || '',
          createdBy: caller._id,
          createdAt: new Date(),
          updatedAt: new Date()
        }

        const result = await paymentsCollections.insertOne(paymentDoc)
        
        // Notify member about payment recorded
        const recipient = await userCollections.findOne({ _id: userObjectId })
        const categoryLabel = category.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())
        await createNotification({
          userId: userObjectId,
          messId: messObjectId,
          type: 'payment_recorded',
          title: 'Payment Recorded',
          message: `Your payment of ৳${numAmount.toLocaleString('en-BD', {minimumFractionDigits: 2})} for ${categoryLabel} has been recorded.`,
          link: '/dashboard/monthly/report'
        })

        return res.send({ success: true, insertedId: result.insertedId })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to create payment.' })
      }
    })

    // PUT /payments/:id — Update payment
    app.put('/payments/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, userId, category, amount, date, note } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let paymentObjectId
      try { paymentObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid payment ID.' }) }

      const existing = await paymentsCollections.findOne({ _id: paymentObjectId })
      if (!existing) return res.status(404).send({ message: 'Payment not found.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can edit payments.' })
      }

      const updates = { updatedAt: new Date() }

      if (userId !== undefined) {
        let userObjectId
        try { userObjectId = new ObjectId(userId) }
        catch { return res.status(400).send({ message: 'Invalid user ID.' }) }

        // Verify new user is active member
        const recipientMembership = await messMemberCollections.findOne({
          userId: userObjectId,
          messId: existing.messId,
          status: 'active'
        })
        if (!recipientMembership) {
          return res.status(400).send({ message: 'Payment recipient is not an active member of this mess.' })
        }
        updates.userId = userObjectId
      }

      if (category !== undefined) {
        const validCategories = ['meal', 'rent', 'khalabill', 'common_expense', 'other']
        if (!validCategories.includes(category)) {
          return res.status(400).send({ message: 'Invalid category.' })
        }
        updates.category = category
      }

      if (amount !== undefined) {
        const numAmount = Number(amount)
        if (isNaN(numAmount) || numAmount <= 0) {
          return res.status(400).send({ message: 'amount must be a positive number.' })
        }
        updates.amount = numAmount
      }

      if (date !== undefined) {
        // Validate date is current month
        const [reqYear, reqMonth, reqDay] = date.split('-').map(Number)
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
        const currentYear = now.getFullYear()
        const currentMonth = now.getMonth() + 1

        if (reqYear !== currentYear || reqMonth !== currentMonth) {
          return res.status(400).send({ message: 'Payments can only be set for the current month.' })
        }
        updates.date = toMidnightUTC(date)
      }

      if (note !== undefined) updates.note = note.trim()

      // Check if month is closed
      const paymentDate = updates.date || existing.date
      const dateObj = new Date(paymentDate)
      const monthStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: existing.messId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        await paymentsCollections.updateOne(
          { _id: paymentObjectId },
          { $set: updates }
        )

        // NOTIFICATION: payment_updated → notify the affected member
        const affectedUserId = updates.userId || existing.userId
        const affectedMember = await messMemberCollections.findOne({
          userId: affectedUserId,
          messId: existing.messId,
          status: 'active'
        })

        if (affectedMember) {
          await createNotification({
            userId: affectedMember.userId,
            messId: existing.messId,
            type: 'payment_updated',
            title: 'Payment Updated',
            message: `Manager updated a ${updates.category || existing.category} payment record for you.`,
            link: `/dashboard/payments`
          })
          console.log(`[NOTIFICATION] payment_updated created for user ${affectedMember.userId} in mess ${existing.messId}`)
        }

        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to update payment.' })
      }
    })

    // DELETE /payments/:id — Delete payment
    app.delete('/payments/:id', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let paymentObjectId
      try { paymentObjectId = new ObjectId(req.params.id) }
      catch { return res.status(400).send({ message: 'Invalid payment ID.' }) }

      const existing = await paymentsCollections.findOne({ _id: paymentObjectId })
      if (!existing) return res.status(404).send({ message: 'Payment not found.' })

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      // Verify caller is manager
      const managerMembership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: existing.messId,
        role: 'manager',
        status: 'active',
      })
      if (!managerMembership) {
        return res.status(403).send({ message: 'Only managers can delete payments.' })
      }

      // Check if month is closed
      const dateObj = new Date(existing.date)
      const monthStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}`
      const closedMonth = await monthlyReportsCollections.findOne({
        messId: existing.messId,
        month: monthStr
      })
      if (closedMonth) {
        return res.status(400).send({ message: 'This month is already closed and cannot be modified.' })
      }

      try {
        // NOTIFICATION: payment_deleted → notify the affected member BEFORE deleting
        const affectedMember = await messMemberCollections.findOne({
          userId: existing.userId,
          messId: existing.messId,
          status: 'active'
        })

        if (affectedMember) {
          await createNotification({
            userId: affectedMember.userId,
            messId: existing.messId,
            type: 'payment_deleted',
            title: 'Payment Deleted',
            message: `Manager removed a ${existing.category} payment record.`,
            link: `/dashboard/payments`
          })
          console.log(`[NOTIFICATION] payment_deleted created for user ${affectedMember.userId} in mess ${existing.messId}`)
        }

        await paymentsCollections.deleteOne({ _id: paymentObjectId })
        return res.send({ success: true })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to delete payment.' })
      }
    })

    // ========================================
    // CALCULATIONS & SETTLEMENT API
    // ========================================

    // GET /calculations/:messId — Get current month calculations and settlement
    app.get('/calculations/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      const caller = await userCollections.findOne({ email })
      if (!caller) return res.status(404).send({ message: 'User not found.' })

      const membership = await messMemberCollections.findOne({
        userId: caller._id,
        messId: messObjectId,
        status: 'active',
      })
      if (!membership) {
        return res.status(403).send({ message: 'You are not a member of this mess.' })
      }

      // Get current month
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }))
      const year = now.getFullYear()
      const month = now.getMonth()
      const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`
      const startDate = new Date(Date.UTC(year, month, 1))
      const endDate = new Date(Date.UTC(year, month + 1, 1)) // Exclusive upper bound

      try {
        // Get active members
        const activeMembers = await messMemberCollections
          .find({ messId: messObjectId, status: 'active' })
          .toArray()
        
        const memberIds = activeMembers.map(m => m.userId)
        
        // Populate member user info
        const memberUsers = await userCollections
          .find({ _id: { $in: memberIds } })
          .project({ name: 1, email: 1, photoURL: 1 })
          .toArray()
        
        const memberMap = {}
        memberUsers.forEach(u => {
          memberMap[u._id.toString()] = u
        })

        // Get approved bazar total
        const approvedBazar = await bazarCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate },
            status: 'approved'
          })
          .toArray()
        
        const totalBazarCost = approvedBazar.reduce((sum, b) => sum + b.totalAmount, 0)

        // Get meal documents for current month
        const mealDocs = await mealCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate }
          })
          .toArray()

        // Calculate total meals and member-wise meals from entries array
        let totalMeals = 0
        const memberMeals = {}
        
        // Initialize meals for all active members
        memberIds.forEach(id => {
          memberMeals[id.toString()] = {
            breakfast: 0,
            lunch: 0,
            dinner: 0,
            guestMeal: 0,
            total: 0
          }
        })

        // Aggregate meals from all daily documents
        mealDocs.forEach(doc => {
          if (doc.entries && Array.isArray(doc.entries)) {
            doc.entries.forEach(entry => {
              const key = entry.userId.toString()
              // Only count meals for active members
              if (memberMeals[key]) {
                const breakfast = Number(entry.breakfast || 0)
                const lunch = Number(entry.lunch || 0)
                const dinner = Number(entry.dinner || 0)
                const guestMeal = Number(entry.guestMeal || 0)
                
                memberMeals[key].breakfast += breakfast
                memberMeals[key].lunch += lunch
                memberMeals[key].dinner += dinner
                memberMeals[key].guestMeal += guestMeal
                memberMeals[key].total += breakfast + lunch + dinner + guestMeal
              }
            })
          }
        })

        // Calculate total meals across all members
        Object.values(memberMeals).forEach(m => {
          totalMeals += m.total
        })

        const mealRate = totalMeals > 0 ? totalBazarCost / totalMeals : 0

        // Get khalabill
        const khalabill = await khalabillCollections.findOne({
          messId: messObjectId,
          month: monthStr
        })
        
        const totalKhalabill = khalabill?.amount || 0
        const perMemberKhalabill = activeMembers.length > 0 ? totalKhalabill / activeMembers.length : 0

        // Get common expenses
        const commonExpenses = await commonExpensesCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate }
          })
          .toArray()
        
        const totalCommonExpense = commonExpenses.reduce((sum, e) => sum + e.amount, 0)
        const perMemberCommonExpense = activeMembers.length > 0 ? totalCommonExpense / activeMembers.length : 0

        // Get member rents
        const rents = await memberRentCollections
          .find({
            messId: messObjectId,
            month: monthStr
          })
          .toArray()
        
        const memberRents = {}
        let totalRent = 0
        rents.forEach(r => {
          memberRents[r.userId.toString()] = r.amount
          totalRent += r.amount
        })

        // Get payments
        const payments = await paymentsCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate }
          })
          .toArray()

        // Calculate member-wise payments
        const memberPayments = {}
        const memberPaymentsByCategory = {}
        const memberPaymentDetails = {}
        
        memberIds.forEach(id => {
          const key = id.toString()
          memberPayments[key] = 0
          memberPaymentsByCategory[key] = {
            meal: 0,
            rent: 0,
            khalabill: 0,
            common_expense: 0,
            other: 0
          }
          memberPaymentDetails[key] = []
        })

        payments.forEach(p => {
          const key = p.userId.toString()
          if (memberPayments[key] !== undefined) {
            memberPayments[key] += p.amount
            if (memberPaymentsByCategory[key][p.category] !== undefined) {
              memberPaymentsByCategory[key][p.category] += p.amount
            }
            memberPaymentDetails[key].push({
              category: p.category,
              amount: p.amount,
              note: p.note,
              date: p.date
            })
          }
        })

        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0)

        // Calculate member settlement
        const memberSettlement = memberIds.map(userId => {
          const key = userId.toString()
          const user = memberMap[key]
          const foodCost = (memberMeals[key]?.total || 0) * mealRate
          const rent = memberRents[key] || 0
          const khalabill = perMemberKhalabill
          const commonExpense = perMemberCommonExpense
          const totalCost = foodCost + rent + khalabill + commonExpense
          const paid = memberPayments[key] || 0
          const balance = totalCost - paid
          
          let status = 'Settled'
          if (balance > 0.01) status = 'Due'
          else if (balance < -0.01) status = 'Advance'

          return {
            userId: userId.toString(),
            user,
            meals: memberMeals[key],
            foodCost,
            rent,
            khalabill,
            commonExpense,
            totalCost,
            paid,
            paymentsByCategory: memberPaymentsByCategory[key],
            payments: memberPaymentDetails[key],
            balance,
            status
          }
        })

        // Calculate totals
        let totalDue = 0
        let totalAdvance = 0
        memberSettlement.forEach(m => {
          if (m.status === 'Due') totalDue += m.balance
          else if (m.status === 'Advance') totalAdvance += Math.abs(m.balance)
        })

        const totalCost = totalBazarCost + totalRent + totalKhalabill + totalCommonExpense

        return res.send({
          summary: {
            totalCost,
            totalPaid,
            totalDue,
            totalAdvance
          },
          mealCalculation: {
            totalBazarCost,
            totalMeals,
            mealRate
          },
          rentCalculation: {
            totalRent,
            activeMembers: activeMembers.length
          },
          khalabillCalculation: {
            totalKhalabill,
            activeMembers: activeMembers.length,
            perMember: perMemberKhalabill
          },
          commonExpenseCalculation: {
            totalCommonExpense,
            activeMembers: activeMembers.length,
            perMember: perMemberCommonExpense
          },
          memberSettlement
        })
      } catch (err) {
        console.error(err)
        return res.status(500).send({ message: 'Failed to calculate settlement.' })
      }
    })

    // =====================================================
    // NOTIFICATIONS SYSTEM
    // =====================================================

    // Helper function to create notifications
    const createNotification = async ({ userId, messId, type, title, message, link }) => {
      try {
        console.log('[Notification] Creating notification:', { 
          userId: userId?.toString(), 
          messId: messId?.toString(), 
          type, 
          title 
        })
        
        const result = await notificationsCollections.insertOne({
          userId,
          messId,
          type,
          title,
          message,
          link,
          isRead: false,
          createdAt: new Date()
        })
        
        console.log('[Notification] Created successfully with ID:', result.insertedId?.toString())
      } catch (err) {
        console.error('[Notification] Failed to create notification:', err)
        console.error('[Notification] Details:', { userId, messId, type, title, message, link })
      }
    }

    // GET /notifications?email=userEmail
    // Returns current user's notifications for their current active Mess
    app.get('/notifications', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query
      
      console.log('[Notification API] Fetching notifications for email:', email)
      
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      try {
        // Get user
        const user = await userCollections.findOne({ email })
        if (!user) {
          console.log('[Notification API] User not found')
          return res.status(404).send({ message: 'User not found.' })
        }
        
        console.log('[Notification API] User found:', user._id?.toString())

        // Get current active mess membership
        const membership = await messMemberCollections.findOne({ userId: user._id, status: 'active' })
        if (!membership) {
          console.log('[Notification API] No active mess membership found')
          return res.status(200).send([]) // No active mess, no notifications
        }
        
        console.log('[Notification API] Active membership found. MessId:', membership.messId?.toString())

        // Get notifications for this user + mess, sorted newest first
        const notifications = await notificationsCollections.find({
          userId: user._id,
          messId: membership.messId
        }).sort({ createdAt: -1 }).toArray()
        
        console.log('[Notification API] Found notifications:', notifications.length)

        res.status(200).send(notifications)
      } catch (err) {
        console.error('[Notification API] Error:', err)
        res.status(500).send({ message: 'Failed to fetch notifications.' })
      }
    })

    // GET /notifications/unread-count?email=userEmail
    // Returns unread count for current user's active mess
    app.get('/notifications/unread-count', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query
      
      console.log('[Notification API] Fetching unread count for email:', email)
      
      if (!email) return res.status(400).send({ message: 'Email is required.' })

      try {
        // Get user
        const user = await userCollections.findOne({ email })
        if (!user) {
          console.log('[Notification API] User not found for unread count')
          return res.status(404).send({ message: 'User not found.' })
        }

        // Get current active mess membership
        const membership = await messMemberCollections.findOne({ userId: user._id, status: 'active' })
        if (!membership) {
          console.log('[Notification API] No active membership for unread count')
          return res.status(200).send({ unreadCount: 0 })
        }

        // Count unread notifications
        const unreadCount = await notificationsCollections.countDocuments({
          userId: user._id,
          messId: membership.messId,
          isRead: false
        })
        
        console.log('[Notification API] Unread count:', unreadCount)

        res.status(200).send({ unreadCount })
      } catch (err) {
        console.error('[Notification API] Error fetching unread count:', err)
        res.status(500).send({ message: 'Failed to fetch unread count.' })
      }
    })

    // PATCH /notifications/:id/read
    // Mark one notification as read
    app.patch('/notifications/:id/read', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { id } = req.params
      const { email } = req.body

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      try {
        const user = await userCollections.findOne({ email })
        if (!user) return res.status(404).send({ message: 'User not found.' })

        let notificationId
        try {
          notificationId = new ObjectId(id)
        } catch {
          return res.status(400).send({ message: 'Invalid notification ID.' })
        }

        // Verify ownership
        const notification = await notificationsCollections.findOne({ _id: notificationId })
        if (!notification) return res.status(404).send({ message: 'Notification not found.' })
        if (!notification.userId.equals(user._id)) {
          return res.status(403).send({ message: 'You cannot modify another user\'s notification.' })
        }

        // Mark as read
        await notificationsCollections.updateOne(
          { _id: notificationId },
          { $set: { isRead: true } }
        )

        res.status(200).send({ message: 'Notification marked as read.' })
      } catch (err) {
        console.error(err)
        res.status(500).send({ message: 'Failed to mark notification as read.' })
      }
    })

    // PATCH /notifications/read-all
    // Mark all notifications as read for current user's active mess
    app.patch('/notifications/read-all', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.body

      if (!email) return res.status(400).send({ message: 'Email is required.' })

      try {
        const user = await userCollections.findOne({ email })
        if (!user) return res.status(404).send({ message: 'User not found.' })

        const membership = await messMemberCollections.findOne({ userId: user._id, status: 'active' })
        if (!membership) return res.status(200).send({ message: 'No active mess.' })

        // Mark all unread as read
        const result = await notificationsCollections.updateMany(
          { userId: user._id, messId: membership.messId, isRead: false },
          { $set: { isRead: true } }
        )

        res.status(200).send({ message: 'All notifications marked as read.', count: result.modifiedCount })
      } catch (err) {
        console.error(err)
        res.status(500).send({ message: 'Failed to mark all as read.' })
      }
    })

    // =====================================================
    // MONTH CLOSING & HISTORICAL REPORTS
    // =====================================================

    // POST /close-month/:messId — Close a calendar month and create historical snapshot
    app.post('/close-month/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, month, selectedMemberIds } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!month) return res.status(400).send({ message: 'month is required.' })
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).send({ message: 'month must be in YYYY-MM format.' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      try {
        // 1. Verify authenticated user
        const caller = await userCollections.findOne({ email })
        if (!caller) return res.status(404).send({ message: 'User not found.' })

        // 2. Verify user is the active Manager
        const managerMembership = await messMemberCollections.findOne({
          userId: caller._id,
          messId: messObjectId,
          role: 'manager',
          status: 'active',
        })
        if (!managerMembership) {
          return res.status(403).send({ message: 'Only the active manager can close a month.' })
        }

        // 3. Check if month is already closed
        const existingReport = await monthlyReportsCollections.findOne({
          messId: messObjectId,
          month
        })
        if (existingReport) {
          return res.status(400).send({ message: 'This month is already closed.' })
        }

        // 4. Get mess info
        const mess = await messCollections.findOne({ _id: messObjectId })
        if (!mess) return res.status(404).send({ message: 'Mess not found.' })

        // 5. Calculate monthly snapshot using EXISTING calculation logic
        const [year, monthNum] = month.split('-').map(Number)
        const startDate = new Date(Date.UTC(year, monthNum - 1, 1))
        const endDate = new Date(Date.UTC(year, monthNum, 1))

        // Get active members at time of closing
        const activeMembers = await messMemberCollections
          .find({ messId: messObjectId, status: 'active' })
          .toArray()
        
        const memberIds = activeMembers.map(m => m.userId)
        
        // Populate member user info
        const memberUsers = await userCollections
          .find({ _id: { $in: memberIds } })
          .project({ name: 1, email: 1, photoURL: 1 })
          .toArray()
        
        const memberMap = {}
        memberUsers.forEach(u => {
          memberMap[u._id.toString()] = u
        })

        // Get approved bazar total
        const approvedBazar = await bazarCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate },
            status: 'approved'
          })
          .toArray()
        
        const totalBazarCost = approvedBazar.reduce((sum, b) => sum + b.totalAmount, 0)

        // Get meal documents
        const mealDocs = await mealCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate }
          })
          .toArray()

        // Calculate total meals and member-wise meals
        let totalMeals = 0
        const memberMeals = {}
        
        memberIds.forEach(id => {
          memberMeals[id.toString()] = {
            breakfast: 0,
            lunch: 0,
            dinner: 0,
            guestMeal: 0,
            total: 0
          }
        })

        mealDocs.forEach(doc => {
          if (doc.entries && Array.isArray(doc.entries)) {
            doc.entries.forEach(entry => {
              const key = entry.userId.toString()
              if (memberMeals[key]) {
                const breakfast = Number(entry.breakfast || 0)
                const lunch = Number(entry.lunch || 0)
                const dinner = Number(entry.dinner || 0)
                const guestMeal = Number(entry.guestMeal || 0)
                
                memberMeals[key].breakfast += breakfast
                memberMeals[key].lunch += lunch
                memberMeals[key].dinner += dinner
                memberMeals[key].guestMeal += guestMeal
                memberMeals[key].total += breakfast + lunch + dinner + guestMeal
              }
            })
          }
        })

        Object.values(memberMeals).forEach(m => {
          totalMeals += m.total
        })

        const mealRate = totalMeals > 0 ? totalBazarCost / totalMeals : 0

        // Get khalabill
        const khalabill = await khalabillCollections.findOne({
          messId: messObjectId,
          month
        })
        
        const totalKhalabill = khalabill?.amount || 0
        const perMemberKhalabill = activeMembers.length > 0 ? totalKhalabill / activeMembers.length : 0

        // Get common expenses
        const commonExpenses = await commonExpensesCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate }
          })
          .toArray()
        
        const totalCommonExpense = commonExpenses.reduce((sum, e) => sum + e.amount, 0)
        const perMemberCommonExpense = activeMembers.length > 0 ? totalCommonExpense / activeMembers.length : 0

        // Get member rents
        const rents = await memberRentCollections
          .find({
            messId: messObjectId,
            month
          })
          .toArray()
        
        const memberRents = {}
        let totalRent = 0
        rents.forEach(r => {
          memberRents[r.userId.toString()] = r.amount
          totalRent += r.amount
        })

        // Get payments
        const payments = await paymentsCollections
          .find({
            messId: messObjectId,
            date: { $gte: startDate, $lt: endDate }
          })
          .toArray()

        const memberPayments = {}
        const memberPaymentsByCategory = {}
        
        memberIds.forEach(id => {
          const key = id.toString()
          memberPayments[key] = 0
          memberPaymentsByCategory[key] = {
            meal: 0,
            rent: 0,
            khalabill: 0,
            common_expense: 0,
            other: 0
          }
        })

        payments.forEach(p => {
          const key = p.userId.toString()
          if (memberPayments[key] !== undefined) {
            memberPayments[key] += p.amount
            if (memberPaymentsByCategory[key][p.category] !== undefined) {
              memberPaymentsByCategory[key][p.category] += p.amount
            }
          }
        })

        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0)

        // Build member settlement snapshot
        const memberSettlement = memberIds.map(userId => {
          const key = userId.toString()
          const user = memberMap[key]
          const foodCost = (memberMeals[key]?.total || 0) * mealRate
          const rent = memberRents[key] || 0
          const khalabill = perMemberKhalabill
          const commonExpense = perMemberCommonExpense
          const totalCost = foodCost + rent + khalabill + commonExpense
          const paid = memberPayments[key] || 0
          const balance = totalCost - paid
          
          let status = 'Settled'
          if (balance > 0.01) status = 'Due'
          else if (balance < -0.01) status = 'Advance'

          return {
            userId: userId,
            name: user?.name || 'Unknown',
            email: user?.email || '',
            meals: {
              breakfast: memberMeals[key].breakfast,
              lunch: memberMeals[key].lunch,
              dinner: memberMeals[key].dinner,
              guestMeal: memberMeals[key].guestMeal,
              total: memberMeals[key].total
            },
            foodCost,
            rent,
            khalabill,
            commonExpense,
            totalCost,
            totalPaid: paid,
            balance,
            status
          }
        })

        let totalDue = 0
        let totalAdvance = 0
        memberSettlement.forEach(m => {
          if (m.status === 'Due') totalDue += m.balance
          else if (m.status === 'Advance') totalAdvance += Math.abs(m.balance)
        })

        const totalCost = totalBazarCost + totalRent + totalKhalabill + totalCommonExpense

        // 6. Create monthly report snapshot
        const monthlyReportDoc = {
          messId: messObjectId,
          month,
          status: 'closed',
          closedAt: new Date(),
          closedBy: caller._id,
          summary: {
            totalMeals,
            totalBazarCost,
            mealRate,
            totalKhalabill,
            totalCommonExpense,
            totalRent,
            totalPayments: totalPaid,
            totalCost,
            totalDue,
            totalAdvance,
            activeMemberCount: activeMembers.length
          },
          members: memberSettlement
        }

        await monthlyReportsCollections.insertOne(monthlyReportDoc)

        // 7. Process member removals
        const removedMembers = []
        if (Array.isArray(selectedMemberIds) && selectedMemberIds.length > 0) {
          // Validate selected members
          const selectedIds = []
          for (const id of selectedMemberIds) {
            try {
              const objId = new ObjectId(id)
              selectedIds.push(objId)
            } catch {
              return res.status(400).send({ message: `Invalid member ID: ${id}` })
            }
          }

          // Prevent manager from removing themselves
          const managerIdStr = caller._id.toString()
          if (selectedIds.some(id => id.toString() === managerIdStr)) {
            return res.status(400).send({ message: 'Manager cannot remove themselves.' })
          }

          // Get members to remove
          const membersToRemove = await messMemberCollections
            .find({
              userId: { $in: selectedIds },
              messId: messObjectId,
              status: 'active'
            })
            .toArray()

          // Remove members (set status to inactive)
          for (const member of membersToRemove) {
            await messMemberCollections.updateOne(
              { _id: member._id },
              { 
                $set: { 
                  status: 'inactive',
                  leftAt: new Date(),
                  updatedAt: new Date()
                } 
              }
            )

            // Update user's hasMess flag
            await userCollections.updateOne(
              { _id: member.userId },
              { $set: { hasMess: false, updatedAt: new Date() } }
            )

            removedMembers.push(member)

            // Create notification for removed member
            await createNotification({
              userId: member.userId,
              messId: messObjectId,
              type: 'removed_from_mess',
              title: 'Removed from Mess',
              message: `You have been removed from ${mess.messName}. Your finalized monthly report for ${month} has been preserved.`,
              link: '/dashboard'
            })
          }
        }

        return res.send({ 
          success: true, 
          message: 'Month closed successfully.',
          removedCount: removedMembers.length
        })
      } catch (err) {
        console.error('Failed to close month:', err)
        return res.status(500).send({ message: 'Failed to close month.' })
      }
    })

    // GET /monthly-reports/:messId — Get all historical reports for a mess
    app.get('/monthly-reports/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query

      if (!email) return res.status(400).send({ message: 'email is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      try {
        const caller = await userCollections.findOne({ email })
        if (!caller) return res.status(404).send({ message: 'User not found.' })

        // Verify user is member of this mess
        const membership = await messMemberCollections.findOne({
          userId: caller._id,
          messId: messObjectId,
          status: 'active',
        })
        if (!membership) {
          return res.status(403).send({ message: 'You are not a member of this mess.' })
        }

        // If manager, return all reports; if member, return only their reports
        if (membership.role === 'manager') {
          const reports = await monthlyReportsCollections
            .find({ messId: messObjectId })
            .sort({ closedAt: -1 })
            .toArray()
          
          return res.send({ reports })
        } else {
          // Member can only see their own data
          const reports = await monthlyReportsCollections
            .find({ messId: messObjectId })
            .sort({ closedAt: -1 })
            .toArray()
          
          // Filter to only include member's own data
          const memberReports = reports.map(report => {
            const memberData = report.members.find(m => m.userId.toString() === caller._id.toString())
            if (!memberData) return null
            
            return {
              _id: report._id,
              month: report.month,
              closedAt: report.closedAt,
              memberData
            }
          }).filter(Boolean)
          
          return res.send({ reports: memberReports })
        }
      } catch (err) {
        console.error('Failed to fetch historical reports:', err)
        return res.status(500).send({ message: 'Failed to fetch historical reports.' })
      }
    })

    // GET /monthly-reports/:messId/:month — Get specific month report
    app.get('/monthly-reports/:messId/:month', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email } = req.query
      const { month } = req.params

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).send({ message: 'month must be in YYYY-MM format.' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      try {
        const caller = await userCollections.findOne({ email })
        if (!caller) return res.status(404).send({ message: 'User not found.' })

        const membership = await messMemberCollections.findOne({
          userId: caller._id,
          messId: messObjectId,
          status: 'active',
        })
        if (!membership) {
          return res.status(403).send({ message: 'You are not a member of this mess.' })
        }

        const report = await monthlyReportsCollections.findOne({
          messId: messObjectId,
          month
        })

        if (!report) {
          return res.status(404).send({ message: 'Report not found.' })
        }

        // If manager, return full report; if member, return only their data
        if (membership.role === 'manager') {
          return res.send({ report })
        } else {
          const memberData = report.members.find(m => m.userId.toString() === caller._id.toString())
          if (!memberData) {
            return res.status(404).send({ message: 'Your data not found in this report.' })
          }
          
          return res.send({ 
            report: {
              _id: report._id,
              month: report.month,
              closedAt: report.closedAt,
              summary: report.summary,
              memberData
            }
          })
        }
      } catch (err) {
        console.error('Failed to fetch month report:', err)
        return res.status(500).send({ message: 'Failed to fetch month report.' })
      }
    })

    // GET /month-status/:messId/:month — Check if a month is closed
    app.get('/month-status/:messId/:month', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { month } = req.params

      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).send({ message: 'month must be in YYYY-MM format.' })
      }

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      try {
        const report = await monthlyReportsCollections.findOne({
          messId: messObjectId,
          month
        })

        return res.send({ 
          isClosed: !!report,
          closedAt: report?.closedAt || null
        })
      } catch (err) {
        console.error('Failed to check month status:', err)
        return res.status(500).send({ message: 'Failed to check month status.' })
      }
    })

    // =====================================================
    // MANAGER CHANGE
    // =====================================================

    // POST /change-manager/:messId — Transfer manager role to another active member
    app.post('/change-manager/:messId', async (req, res) => {
      const { ObjectId } = require('mongodb')
      const { email, newManagerUserId } = req.body

      if (!email) return res.status(400).send({ message: 'email is required.' })
      if (!newManagerUserId) return res.status(400).send({ message: 'newManagerUserId is required.' })

      let messObjectId
      try { messObjectId = new ObjectId(req.params.messId) }
      catch { return res.status(400).send({ message: 'Invalid mess ID.' }) }

      let newManagerUserObjectId
      try { newManagerUserObjectId = new ObjectId(newManagerUserId) }
      catch { return res.status(400).send({ message: 'Invalid new manager user ID.' }) }

      try {
        // Verify current user is the active manager
        const caller = await userCollections.findOne({ email })
        if (!caller) return res.status(404).send({ message: 'User not found.' })

        const currentManagerMembership = await messMemberCollections.findOne({
          userId: caller._id,
          messId: messObjectId,
          role: 'manager',
          status: 'active',
        })
        if (!currentManagerMembership) {
          return res.status(403).send({ message: 'Only the active manager can change managers.' })
        }

        // Cannot change to self
        if (caller._id.toString() === newManagerUserObjectId.toString()) {
          return res.status(400).send({ message: 'You are already the manager.' })
        }

        // Verify new manager is an active member
        const newManagerMembership = await messMemberCollections.findOne({
          userId: newManagerUserObjectId,
          messId: messObjectId,
          status: 'active',
        })
        if (!newManagerMembership) {
          return res.status(400).send({ message: 'Selected user is not an active member of this mess.' })
        }

        // Get mess info for notifications
        const mess = await messCollections.findOne({ _id: messObjectId })
        if (!mess) return res.status(404).send({ message: 'Mess not found.' })

        const now = new Date()

        // Downgrade current manager to member
        await messMemberCollections.updateOne(
          { _id: currentManagerMembership._id },
          { $set: { role: 'member', updatedAt: now } }
        )

        // Upgrade new member to manager
        await messMemberCollections.updateOne(
          { _id: newManagerMembership._id },
          { $set: { role: 'manager', updatedAt: now } }
        )

        // Notify new manager
        await createNotification({
          userId: newManagerUserObjectId,
          messId: messObjectId,
          type: 'manager_changed',
          title: 'You Are Now the Manager',
          message: `You have been appointed as the manager of ${mess.messName}.`,
          link: '/dashboard'
        })

        // Notify previous manager
        await createNotification({
          userId: caller._id,
          messId: messObjectId,
          type: 'manager_changed',
          title: 'Manager Role Changed',
          message: `Your role in ${mess.messName} has been changed to Member.`,
          link: '/dashboard'
        })

        return res.send({ 
          success: true, 
          message: 'Manager changed successfully.' 
        })
      } catch (err) {
        console.error('Failed to change manager:', err)
        return res.status(500).send({ message: 'Failed to change manager.' })
      }
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
