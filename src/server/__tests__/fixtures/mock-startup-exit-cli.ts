const startupStdout = process.env.MOCK_SDK_STARTUP_STDOUT || ''

if (startupStdout) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${startupStdout}\n`, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

process.exitCode = 1
