import {
  compileFile,
  File,
  mergeImportMap,
  useStore as useReplStore,
  type ImportMap,
  type StoreState,
} from '@vue/repl'
import { objectOmit, debouncedWatch } from '@vueuse/core'
import { format as prettierFormat } from 'prettier/standalone'
import * as prettierPluginEstree from "prettier/plugins/estree";
import * as parserBabel from "prettier/parser-babel";
import * as parserHtml from "prettier/parser-html";
import * as parserPostCSS from "prettier/parser-postcss";
import * as prettier from "prettier/standalone";
import { IS_DEV } from '@/constants'
import {
  genCdnLink,
  genCompilerSfcLink,
  genImportMap,
} from '@/utils/dependency'
import { atou, utoa } from '@/utils/encode'
import elementPlusCode from '../template/element-plus.js?raw'
import mainCode from '../template/main.vue?raw'
import tsconfigCode from '../template/tsconfig.json?raw'
import welcomeCode from '../template/welcome.vue?raw'

export interface Initial {
  serializedState?: string
  initialized?: () => void
}
export type VersionKey = 'vue' | 'elementPlus' | 'typescript'
export type Versions = Record<VersionKey, string>
export interface UserOptions {
  styleSource?: string
  showHidden?: boolean
  vueVersion?: string
  tsVersion?: string
  epVersion?: string
}
export type SerializeState = Record<string, string> & {
  _o?: UserOptions
}

const MAIN_FILE = 'src/PlaygroundMain.vue'
const APP_FILE = 'src/App.vue'
const ELEMENT_PLUS_FILE = 'src/element-plus.js'
const LEGACY_IMPORT_MAP = 'src/import_map.json'
export const IMPORT_MAP = 'import-map.json'
export const TSCONFIG = 'tsconfig.json'

export const useStore = (initial: Initial) => {
  const saved: SerializeState | undefined = initial.serializedState
    ? deserialize(initial.serializedState)
    : undefined
  const pr =
    new URLSearchParams(location.search).get('pr') ||
    saved?._o?.styleSource?.split('-', 2)[1]
  const prUrl = `https://preview-${pr}-element-plus.surge.sh/bundle/dist`

  const versions = reactive<Versions>({
    vue: saved?._o?.vueVersion ?? 'latest',
    elementPlus: pr ? 'preview' : (saved?._o?.epVersion ?? 'latest'),
    typescript: saved?._o?.tsVersion ?? 'latest',
  })
  const userOptions: UserOptions = pr
    ? {
        showHidden: true,
        styleSource: `${prUrl}/index.css`,
      }
    : {}
  Object.assign(userOptions, {
    vueVersion: saved?._o?.vueVersion,
    tsVersion: saved?._o?.tsVersion,
    epVersion: saved?._o?.epVersion,
  })
  const hideFile = !IS_DEV && !userOptions.showHidden

  const [nightly, toggleNightly] = useToggle(false)
  const builtinImportMap = computed<ImportMap>(() => {
    let importMap = genImportMap(versions, nightly.value)
    if (pr)
      importMap = mergeImportMap(importMap, {
        imports: {
          'element-plus': `${prUrl}/index.full.min.mjs`,
          'element-plus/': 'unsupported',
        },
      })
    return importMap
  })

  const storeState: Partial<StoreState> = toRefs(
    reactive({
      files: initFiles(),
      mainFile: MAIN_FILE,
      activeFilename: APP_FILE,
      vueVersion: computed(() => versions.vue),
      typescriptVersion: versions.typescript,
      builtinImportMap,
      template: {
        welcomeSFC: mainCode,
      },
      sfcOptions: {
        script: {
          propsDestructure: true,
        },
      },
    }),
  )
  const store = useReplStore(storeState)
  store.files[ELEMENT_PLUS_FILE].hidden = hideFile
  store.files[MAIN_FILE].hidden = hideFile
  setVueVersion(versions.vue).then(() => {
    initial.initialized?.()
  })

  watch(
    () => versions.elementPlus,
    (version) => {
      store.files[ELEMENT_PLUS_FILE].code = generateElementPlusCode(
        version,
        userOptions.styleSource,
      ).trim()
      compileFile(store, store.files[ELEMENT_PLUS_FILE]).then(
        (errs) => (store.errors = errs),
      )
    },
  )
  watch(
    builtinImportMap,
    (newBuiltinImportMap) => {
      const importMap = JSON.parse(store.files[IMPORT_MAP].code)
      store.files[IMPORT_MAP].code = JSON.stringify(
        mergeImportMap(importMap, newBuiltinImportMap),
        undefined,
        2,
      )
    },
    { deep: true },
  )

  function generateElementPlusCode(version: string, styleSource?: string) {
    const style = styleSource
      ? styleSource.replace('#VERSION#', version)
      : genCdnLink(
          nightly.value ? '@element-plus/nightly' : 'element-plus',
          version,
          '/dist/index.css',
        )
    const darkStyle = style.replace(
      '/dist/index.css',
      '/theme-chalk/dark/css-vars.css',
    )
    return elementPlusCode
      .replace('#STYLE#', style)
      .replace('#DARKSTYLE#', darkStyle)
  }
  async function generateFormatCode(code: string) {
    try {
      console.log('passe here')
    return await prettierFormat(code, {
      //vueIndentScriptAndStyle: true,
      plugins: [prettierPluginEstree, parserBabel, parserHtml, parserPostCSS],
      semi: false,
      singleQuote: true,
      parser: 'vue',
    })

    } catch (e) {
      console.warn('huh', e)
    throw e
    }
  }
  function init() {
    watchEffect(() => {
      compileFile(store, store.activeFile).then((errs) => (store.errors = errs))
    })
    for (const [filename, file] of Object.entries(store.files)) {
      if (filename === store.activeFilename) continue
      compileFile(store, file).then((errs) => store.errors.push(...errs))
    }

    watch(
      () => [
        store.files[TSCONFIG]?.code,
        store.typescriptVersion,
        store.locale,
        store.dependencyVersion,
        store.vueVersion,
      ],
      useDebounceFn(() => store.reloadLanguageTools?.(), 300),
      { deep: true },
    )
  }
  function serialize() {
    const state: SerializeState = { ...store.getFiles() }
    state._o = userOptions
    return utoa(JSON.stringify(state))
  }
  function deserialize(text: string): SerializeState {
    const state = JSON.parse(atou(text))
    return state
  }
  function initFiles() {
    const files: Record<string, File> = Object.create(null)
    if (saved) {
      for (let [filename, file] of Object.entries(objectOmit(saved, ['_o']))) {
        if (
          ![IMPORT_MAP, TSCONFIG].includes(filename) &&
          !filename.startsWith('src/')
        ) {
          filename = `src/${filename}`
        }
        if (filename === LEGACY_IMPORT_MAP) {
          filename = IMPORT_MAP
        }
        files[filename] = new File(filename, file as string)
      }
    } else {
      files[APP_FILE] = new File(APP_FILE, welcomeCode)
    }
    if (!files[ELEMENT_PLUS_FILE]) {
      files[ELEMENT_PLUS_FILE] = new File(
        ELEMENT_PLUS_FILE,
        generateElementPlusCode(versions.elementPlus, userOptions.styleSource),
      )
    }
    if (!files[TSCONFIG]) {
      files[TSCONFIG] = new File(TSCONFIG, tsconfigCode)
    }
    return files
  }
  async function setVueVersion(version: string) {
    store.compiler = await import(
      /* @vite-ignore */ genCompilerSfcLink(version)
    )
    versions.vue = version
  }
  async function setVersion(key: VersionKey, version: string) {
    switch (key) {
      case 'vue':
        userOptions.vueVersion = version
        await setVueVersion(version)
        break
      case 'elementPlus':
        versions.elementPlus = version
        userOptions.epVersion = version
        break
      case 'typescript':
        store.typescriptVersion = version
        userOptions.tsVersion = version
        break
    }
  }

  const nextFormat = ref('')
  const canFormat = computed(() => nextFormat.value === store.activeFile.code)

  debouncedWatch(() => store.activeFile.code, async (code) => {
    //console.log(code)
    nextFormat.value = await generateFormatCode(code).then(val => val).catch(() => code)
    console.log(nextFormat.value)
  }, { debouce: 500 })

  function formatCurrentFile() {
    store.activeFile.code = nextFormat.value
  }

  const utils = {
    versions,
    pr,
    formatCurrentFile,
    canFormat,
    setVersion,
    toggleNightly,
    serialize,
    init,
  }
  Object.assign(store, utils)

  return store as typeof store & typeof utils
}

export type Store = ReturnType<typeof useStore>
