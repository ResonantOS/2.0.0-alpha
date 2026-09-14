// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// The native bridge only reads DSH's catalog. Editing belongs to DSH Settings.
export async function promptLibrary(request = {}, dsh) {
  if (request.action && request.action !== 'list') return {ok:false,error:'Manage prompts in DSH → Settings → Prompt library.'}
  try {
    const result=await dsh('settings.describe',{})
    const section=result.namespaces?.find(row=>row.ns==='prompt-library')
    if (!section) return {ok:false,error:'Enable the Prompt library plugin in DSH, then open Settings → Prompt library.'}
    return {ok:true,library:{revision:section.revision,prompts:section.value.prompts??[]}}
  } catch(error) { return {ok:false,error:'Cannot load DSH prompts. '+error.message} }
}
