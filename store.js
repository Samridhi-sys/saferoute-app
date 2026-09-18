import mongoose from 'mongoose';

// Establish connection to your local database cluster
mongoose.connect('mongodb://localhost:27017/saferoute_db')
    .then(() => console.log('✓ MongoDB connection established successfully.'))
    .catch(err => console.error('✗ MongoDB connection error:', err));

// Define User Schema matching the system requirements
const UserSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    plan: { type: String, default: 'trial' },
    trialStartedAt: { type: Number, default: () => Date.now() },
    lastLoginAt: { type: Number, default: () => Date.now() }
});

const User = mongoose.model('User', UserSchema);

// 1. Fetch user data from the MongoDB collection
export async function getUser(id) {
    try {
        const user = await User.findOne({ id: id });
        if (!user) return null;
        return {
            id: user.id,
            plan: user.plan,
            trialStartedAt: user.trialStartedAt,
            lastLoginAt: user.lastLoginAt
        };
    } catch (err) {
        console.error('Database read error:', err);
        return null;
    }
}

// 2. Insert or Update a user profile record securely
export async function upsertUser(id, data) {
    try {
        const updatedUser = await User.findOneAndUpdate(
            { id: id },
            {
                id: id,
                plan: data.plan,
                trialStartedAt: data.trialStartedAt,
                lastLoginAt: data.lastLoginAt
            },
            { upsert: true, new: true }
        );
        return updatedUser;
    } catch (err) {
        console.error('Database write error:', err);
        return null;
    }
}

// 3. Update an existing user data profile status field
export async function updateUser(id, updateFields) {
    try {
        const updatedUser = await User.findOneAndUpdate(
            { id: id },
            { $set: updateFields },
            { new: true }
        );
        return updatedUser;
    } catch (err) {
        console.error('Database update error:', err);
        return null;
    }
}
