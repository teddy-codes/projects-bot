import path from 'path'
import nedb from 'nedb-promises'
import Discord from 'discord.js'
import { ProjectSubmission, Project, VoteResult } from '../typings/interfaces'
import hasEnoughVotes from '../utils/hasEnoughVotes'

let db: nedb

try {
  db = nedb.create({
    filename: path.resolve(__dirname, '../../data/projects.db'),
    autoload: true
  })
} catch (err) {
  log.error(`Database initialisation failed: ${err}`)
  log.error('Exiting...')
  process.exit(1)
}

export async function checkForDuplicates (submission: ProjectSubmission): Promise<boolean> {
  // Search for potential duplicates with same source and same name
  const haveSameName = await db.find({ name: submission.name }).exec()
  const haveSameSource = await db.find({ links: { source: submission.links.source } }).exec()

  return haveSameName.length > 0 || haveSameSource.length > 0
}

export async function registerProject (submission: ProjectSubmission): Promise<void> {
  await db.insert({
    upvotes: {
      staff: 0,
      veterans: 0
    },
    downvotes: {
      staff: 0,
      veterans: 0
    },
    approved: false,
    rejected: false,
    ...submission
  })
}

export async function getProject (id: Discord.Snowflake): Promise<Project | undefined> {
  const project: Project = await db.findOne({ id })
  return project
}

export async function adjustUpvotesForProject (type: 'add' | 'remove', id: Discord.Snowflake, voter: Discord.GuildMember): Promise<VoteResult> {
  const project: Project = await db.findOne({ id })

  if (!process.env.STAFF_ROLE_ID || !process.env.VETERANS_ROLE_ID) {
    throw new Error(`Staff and veterans role IDs (staff = ${process.env.STAFF_ROLE_ID}, veterans = ${process.env.VETERANS_ROLE_ID}) not set`)
  }

  const isStaff = voter.roles.cache.has(process.env.STAFF_ROLE_ID)
  const isVeteran = voter.roles.cache.has(process.env.VETERANS_ROLE_ID)

  if (!project) {
    log.error(`User ${voter} attempted to ${type === 'add' ? 'upvote' : 'remove upvote for'} non-existent project (ID ${id})`)
    return { success: false, wasApproved: false, reason: 'Project not found', project }
  } else if (!isStaff && !isVeteran) {
    log.warn(`User ${voter} attempted to ${type === 'add' ? 'upvote' : 'remove upvote for'} project ${project.name} (ID ${id}), but member is neither staff nor veteran`)
    return { success: false, wasApproved: false, reason: 'Member does not have voting privileges', project }
  } else {
    let hasEnoughUpvotes

    try {
      hasEnoughUpvotes = hasEnoughVotes('up', type, voter, project)
    } catch (err) {
      // Likely cause here would be misconfiguration, if role IDs and/or voting thresholds are missing or invalid
      return { success: false, wasApproved: false, reason: err.message, project }
    }

    const toUpdate = {
      ...project,
      approved: hasEnoughUpvotes
    }

    const voteType = isStaff ? 'staff' : 'veterans'
    toUpdate.upvotes[voteType] = type === 'add' ? ++project.upvotes[voteType] : --project.upvotes[voteType]

    try {
      await db.update({ id }, toUpdate)
    } catch (err) {
      return { success: false, wasApproved: false, reason: err.message, project }
    }

    return { success: true, wasApproved: hasEnoughUpvotes, reason: '', project }
  }
}

export async function adjustDownvotesForProject (type: 'add' | 'remove', id: Discord.Snowflake, voter: Discord.GuildMember): Promise<VoteResult> {
  const project: Project = await db.findOne({ id })

  if (!process.env.STAFF_ROLE_ID || !process.env.VETERANS_ROLE_ID) {
    throw new Error(`Staff and veterans role IDs (staff = ${process.env.STAFF_ROLE_ID}, veterans = ${process.env.VETERANS_ROLE_ID}) not set`)
  }

  const isStaff = voter.roles.cache.has(process.env.STAFF_ROLE_ID)
  const isVeteran = voter.roles.cache.has(process.env.VETERANS_ROLE_ID)

  if (!project) {
    log.error(`User ${voter} attempted to ${type === 'add' ? 'downvote' : 'remove downvote for'} non-existent project (ID ${id})`)
    return { success: false, wasRejected: false, reason: 'Project not found', project }
  } else if (!isStaff && !isVeteran) {
    log.warn(`User ${voter} attempted to ${type === 'add' ? 'downvote' : 'remove downvote for'} project ${project.name} (ID ${id}), but member is neither staff nor veteran`)
    return { success: false, wasRejected: false, reason: 'Member does not have voting privileges', project }
  } else {
    const hasEnoughDownvotes = hasEnoughVotes('down', type, voter, project)

    const toUpdate = {
      ...project,
      rejected: hasEnoughDownvotes
    }

    const voteType = isStaff ? 'staff' : 'veterans'

    if (type === 'add') {
      toUpdate.downvotes[voteType] = ++project.downvotes[voteType]
    } else {
      // Ensure votes don't go negative if a role change occurs
      toUpdate.downvotes[voteType] = project.downvotes[voteType] - 1 >= 0 ? --project.downvotes[voteType] : 0
    }

    try {
      await db.update({ id }, toUpdate)
    } catch (err) {
      return { success: false, wasRejected: false, reason: err.message, project }
    }

    return { success: true, wasRejected: hasEnoughDownvotes, reason: '', project }
  }
}
