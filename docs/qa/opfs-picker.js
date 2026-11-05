// showDirectoryPicker can't be driven by automation: return an OPFS subfolder named after the picker id instead
window.showDirectoryPicker = async (o = {}) =>
  (await navigator.storage.getDirectory()).getDirectoryHandle('picked-' + (o.id || 'dir'), {create: true})
