import prisma from '@/lib/prisma'
import { GitService } from './gitService'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export interface AnalyzeRepositoryInput {
  name: string
  url: string
  description?: string
  userId: number
}

export class RepositoryService {
  /**
   * Create a new repository record or return existing one
   */
  async createRepository(input: AnalyzeRepositoryInput) {
    // Check if repository with same URL already exists for this user
    const existingRepository = await prisma.repository.findFirst({
      where: {
        url: input.url,
        userId: input.userId,
      },
    })

    if (existingRepository) {
      console.log(`Repository already exists: ${existingRepository.id}`)

      // If analysis failed or pending, retry analysis
      if (existingRepository.status === 'failed' || existingRepository.status === 'pending') {
        console.log(`Retrying analysis for repository ${existingRepository.id}`)
        await prisma.repository.update({
          where: { id: existingRepository.id },
          data: { status: 'analyzing' },
        })
        try {
          await this.analyzeRepository(existingRepository.id)
        } catch (error) {
          console.error(`Failed to re-analyze repository ${existingRepository.id}:`, error)
          await prisma.repository.update({
            where: { id: existingRepository.id },
            data: { status: 'failed' },
          })
          throw error
        }
      }

      return existingRepository
    }

    const repository = await prisma.repository.create({
      data: {
        name: input.name,
        url: input.url,
        description: input.description,
        userId: input.userId,
        status: 'analyzing',
      },
    })

    // In serverless (Vercel), must await or the function will terminate
    // Start analysis immediately (await it)
    try {
      await this.analyzeRepository(repository.id)
    } catch (error) {
      console.error(`Failed to analyze repository ${repository.id}:`, error)
      await prisma.repository.update({
        where: { id: repository.id },
        data: { status: 'failed' },
      })
      throw error
    }

    return repository
  }

  /**
   * Update repository status
   */
  async updateRepositoryStatus(repositoryId: number, status: string) {
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status },
    })
  }

  /**
   * Analyze a repository and store all data
   */
  async analyzeRepository(repositoryId: number) {
    const repository = await prisma.repository.findUnique({
      where: { id: repositoryId },
    })

    if (!repository) {
      throw new Error('Repository not found')
    }

    // Update status to analyzing
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { status: 'analyzing' },
    })

    // Create temporary directory for cloning
    const tempDir = path.join(
      os.tmpdir(),
      'gitverse',
      `repo-${repositoryId}-${crypto.randomBytes(8).toString('hex')}`
    )

    let gitService: GitService | null = null

    try {
      // Clone repository
      console.log(`Cloning repository ${repository.url} to ${tempDir}`)
      gitService = await GitService.cloneRepository(repository.url, tempDir)

      // Get repository size
      const size = await gitService.getRepositorySize()

      // Analyze branches
      console.log(`Analyzing branches for repository ${repositoryId}`)
      const branches = await gitService.getBranches()
      const defaultBranch = branches.find((b) => b.isDefault)?.name || 'main'

      await prisma.branch.createMany({
        data: branches.map((branch) => ({
          name: branch.name,
          isDefault: branch.isDefault,
          isProtected: branch.isProtected,
          commitCount: branch.commitCount,
          lastCommitAt: branch.lastCommitAt,
          repositoryId,
        })),
        skipDuplicates: true,
      })

      // Analyze commits for default branch
      console.log(`Analyzing commits for repository ${repositoryId}`)
      const commits = await gitService.getCommits(defaultBranch, 500)
      console.log(`Total commits fetched from git: ${commits.length}`)

      // Get existing commit hashes for this repository
      const existingCommits = await prisma.commit.findMany({
        where: { repositoryId },
        select: { hash: true, id: true },
      })
      const existingHashes = new Map(existingCommits.map((c) => [c.hash, c.id]))

      // Filter out commits that already exist
      const newCommits = commits.filter((commit) => !existingHashes.has(commit.hash))

      console.log(
        `Found ${commits.length} commits, ${newCommits.length} are new, ${existingCommits.length} already exist`
      )

      let insertedCount = 0
      let failedCount = 0

      for (const commit of newCommits) {
        try {
          const createdCommit = await prisma.commit.create({
            data: {
              hash: commit.hash,
              shortHash: commit.shortHash,
              message: commit.message,
              description: commit.description,
              authorName: commit.authorName,
              authorEmail: commit.authorEmail,
              committedAt: commit.committedAt,
              branch: commit.branch,
              additions: commit.additions,
              deletions: commit.deletions,
              filesChanged: commit.filesChanged,
              repositoryId,
            },
          })

          insertedCount++

          // Store file changes
          if (commit.fileChanges.length > 0) {
            await prisma.fileChange.createMany({
              data: commit.fileChanges.map((change) => ({
                path: change.path,
                additions: change.additions,
                deletions: change.deletions,
                changeType: change.changeType,
                commitId: createdCommit.id,
              })),
              skipDuplicates: true,
            })
          }
        } catch (error: any) {
          failedCount++
          console.error(`Failed to insert commit ${commit.hash}:`, error.message)
          // Continue with next commit
        }
      }

      console.log(`Commit insertion complete: ${insertedCount} inserted, ${failedCount} failed`)

      // Analyze files
      console.log(`Analyzing file tree for repository ${repositoryId}`)
      const files = await gitService.getFileTree()

      // Get existing file paths for this repository
      const existingFiles = await prisma.file.findMany({
        where: { repositoryId },
        select: { path: true },
      })
      const existingPaths = new Set(existingFiles.map((f) => f.path))

      // Filter out files that already exist
      const newFiles = files.filter((file) => !existingPaths.has(file.path))

      if (newFiles.length > 0) {
        // Batch insert new files in chunks of 500
        const chunkSize = 500
        for (let i = 0; i < newFiles.length; i += chunkSize) {
          const chunk = newFiles.slice(i, i + chunkSize)
          await prisma.file.createMany({
            data: chunk.map((file) => ({
              path: file.path,
              name: file.name,
              extension: file.extension,
              size: file.size,
              lines: file.lines,
              language: file.language,
              repositoryId,
            })),
            skipDuplicates: true,
          })
        }
        console.log(`Inserted ${newFiles.length} new files for repository ${repositoryId}`)
      } else {
        console.log(`No new files to insert for repository ${repositoryId}`)
      }

      // Analyze contributors
      console.log(`Analyzing contributors for repository ${repositoryId}`)
      const contributors = await gitService.getContributors()
      const totalContributions = contributors.reduce((sum, c) => sum + c.commits, 0)

      for (const contributor of contributors) {
        const percentage = (contributor.commits / totalContributions) * 100

        await prisma.contributor.create({
          data: {
            name: contributor.name,
            email: contributor.email,
            commits: contributor.commits,
            additions: contributor.additions,
            deletions: contributor.deletions,
            percentage,
            firstCommit: contributor.firstCommit,
            lastCommit: contributor.lastCommit,
            repositoryId,
          },
        })
      }

      // Detect languages
      console.log(`Detecting languages for repository ${repositoryId}`)
      const languages = await gitService.detectLanguages()

      // Languages to ignore (config/data formats, not actual code)
      const ignoredLanguages = ['JSON', 'YAML', 'Markdown', 'TOML', 'CSV']

      // Filter out ignored languages
      const filteredLanguages = languages.filter((lang) => !ignoredLanguages.includes(lang.name))

      // Recalculate percentages based on remaining languages only
      const totalBytes = filteredLanguages.reduce((sum, lang) => sum + lang.bytes, 0)
      const rawPercentages = filteredLanguages.map((lang) =>
        totalBytes > 0 ? (lang.bytes / totalBytes) * 100 : 0
      )

      // Round to 2 decimal places
      const roundedPercentages = rawPercentages.map((p) => Math.round(p * 100) / 100)

      // Adjust to ensure sum is exactly 100%
      const sum = roundedPercentages.reduce((acc, val) => acc + val, 0)
      if (sum > 0 && sum !== 100) {
        const diff = 100 - sum
        // Add difference to the largest percentage
        const maxIndex = roundedPercentages.indexOf(Math.max(...roundedPercentages))
        roundedPercentages[maxIndex] = Math.round((roundedPercentages[maxIndex] + diff) * 100) / 100
      }

      const languagesWithAdjustedPercentage = filteredLanguages.map((lang, index) => ({
        ...lang,
        percentage: roundedPercentages[index],
      }))

      for (const language of languagesWithAdjustedPercentage) {
        await prisma.language.create({
          data: {
            name: language.name,
            percentage: language.percentage,
            bytes: language.bytes,
            lines: language.lines,
            repositoryId,
          },
        })
      }

      // Update repository with final data
      await prisma.repository.update({
        where: { id: repositoryId },
        data: {
          status: 'completed',
          lastAnalyzedAt: new Date(),
          defaultBranch,
          size: size,
        },
      })

      console.log(`Repository ${repositoryId} analysis completed`)
    } catch (error: any) {
      console.error(`Error analyzing repository ${repositoryId}:`, error)
      await prisma.repository.update({
        where: { id: repositoryId },
        data: { status: 'failed' },
      })
      throw error
    } finally {
      // Cleanup cloned repository
      if (gitService) {
        await gitService.cleanup()
      }
    }
  }

  /**
   * Get repository with all related data
   */
  async getRepository(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        branches: {
          orderBy: { isDefault: 'desc' },
        },
        commits: {
          orderBy: { committedAt: 'desc' },
          take: 100,
          include: {
            fileChanges: true,
          },
        },
        contributors: {
          orderBy: { commits: 'desc' },
        },
        languages: {
          orderBy: { percentage: 'desc' },
        },
        files: {
          orderBy: { path: 'asc' },
          take: 500,
        },
      },
    })

    return repository
  }

  /**
   * List all repositories for a user
   */
  async listRepositories(userId: number) {
    const repositories = await prisma.repository.findMany({
      where: { userId },
      include: {
        _count: {
          select: {
            commits: true,
            contributors: true,
            files: true,
            branches: true,
          },
        },
        languages: {
          orderBy: { percentage: 'desc' },
          take: 3,
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return repositories
  }

  /**
   * Delete a repository and all its data
   */
  async deleteRepository(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id, userId },
    })

    if (!repository) {
      throw new Error('Repository not found')
    }

    await prisma.repository.delete({
      where: { id },
    })

    return { success: true }
  }

  /**
   * Get repository statistics
   */
  async getRepositoryStats(id: number, userId: number) {
    const repository = await prisma.repository.findFirst({
      where: { id, userId },
    })

    if (!repository) {
      throw new Error('Repository not found')
    }

    const [totalCommits, totalContributors, totalFiles, totalBranches, recentActivity] =
      await Promise.all([
        prisma.commit.count({ where: { repositoryId: id } }),
        prisma.contributor.count({ where: { repositoryId: id } }),
        prisma.file.count({ where: { repositoryId: id } }),
        prisma.branch.count({ where: { repositoryId: id } }),
        prisma.commit.findMany({
          where: { repositoryId: id },
          orderBy: { committedAt: 'desc' },
          take: 10,
          select: {
            shortHash: true,
            message: true,
            authorName: true,
            committedAt: true,
          },
        }),
      ])

    return {
      totalCommits,
      totalContributors,
      totalFiles,
      totalBranches,
      recentActivity,
      status: repository.status,
      lastAnalyzedAt: repository.lastAnalyzedAt,
    }
  }
}

export const repositoryService = new RepositoryService()
