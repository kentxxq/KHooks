import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import * as ResEdit from 'resedit'
import { developmentProductName, windowsDevelopmentRuntimePrefix } from '../src/shared/app-identity'

export async function prepareWindowsDevExecutable(root: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const source: string = require('electron')
  const sourceInfo = await stat(source)
  const iconData = await readFile(join(root, 'resources', 'icon-dev.ico'))
  const cacheKey = createHash('sha256')
    .update([developmentProductName, source, sourceInfo.mtimeMs, sourceInfo.size].join('\n'))
    .update(iconData)
    .digest('hex')
    .slice(0, 12)
  const debug = join(root, 'debug')
  const runtime = join(debug, windowsDevelopmentRuntimePrefix + cacheKey)
  // Electron 用 exe 文件名判断是否已打包，开发版保留 electron.exe。
  const executableName = basename(source)
  const executablePath = join(runtime, executableName)
  if (existsSync(executablePath)) return executablePath

  await mkdir(debug, { recursive: true })
  const staging = await mkdtemp(join(debug, 'tmpfile-AI-khooks-dev-'))
  try {
    const executable = ResEdit.NtExecutable.from(await readFile(source), { ignoreCert: true })
    const resources = ResEdit.NtExecutableResource.from(executable)
    const icons = ResEdit.Data.IconFile.from(iconData).icons.map((icon) => icon.data)
    const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
    const iconGroup = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)[0]
    if (!versions.length || !iconGroup) throw new Error('Electron 开发运行时缺少 Windows 产品或图标资源')
    for (const version of versions) {
      for (const locale of version.getAllLanguagesForStringValues()) {
        version.setStringValues(locale, {
          ProductName: developmentProductName,
          FileDescription: developmentProductName
        })
      }
      version.outputToResourceEntries(resources.entries)
    }
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, iconGroup.id, iconGroup.lang, icons)
    resources.outputResource(executable)

    await cp(dirname(source), staging, { recursive: true, filter: (path) => path !== source })
    await writeFile(join(staging, executableName), Buffer.from(executable.generate()))
    try {
      await rename(staging, runtime)
    } catch (cause) {
      if (!existsSync(executablePath)) throw cause
    }
    return executablePath
  } finally {
    if (dirname(staging) === debug) await rm(staging, { recursive: true, force: true })
  }
}
