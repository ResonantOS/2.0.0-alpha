// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import type {
  AddOnDockIconName,
  AddOnInstallation,
  AddOnManifest,
  Capability,
  HarnessRegistryProjection,
  ShellSectionId,
} from "../../../src/core/contracts";

export interface AddOnSurfaceDockRoute {
  addonId: string;
  surfaceId: string;
  sectionId: ShellSectionId;
  label: string;
  eyebrow: string;
  dockIcon: AddOnDockIconName;
  order: number;
}

const hasGrantedCapability = (installation: HarnessRegistryProjection["installations"][string], capability: Capability): boolean =>
  installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted);

/**
 * The installations argument is retained for signature compatibility and is not consulted.
 * The host projection is the sole authority; a missing projection yields no dock routes.
 */
export const createAddOnSurfaceDockRoutes = (
  manifests: AddOnManifest[],
  _installations: Record<string, AddOnInstallation>,
  projection?: HarnessRegistryProjection | null,
): AddOnSurfaceDockRoute[] =>
  [...new Map([...manifests, ...(projection?.candidates ?? [])].map(manifest => [manifest.id, manifest])).values()]
    .flatMap((manifest) => {
      const installation = projection?.installations[manifest.id];
      if (!installation?.installed || !installation.enabled) {
        return [];
      }

      if (manifest.systemSlots?.length && !manifest.systemSlots.some(({ id }) =>
        projection?.slots[id]?.available && projection.slots[id]?.addonId === manifest.id)) {
        return [];
      }

      return manifest.surfaces.flatMap((surface): AddOnSurfaceDockRoute[] => {
        const navigation = surface.shellNavigation;
        if (!navigation || installation.hiddenSurfaceIds.includes(surface.id)) {
          return [];
        }
        const missingCapability = (navigation.requiredCapabilities ?? []).find(
          (capability) => !hasGrantedCapability(installation, capability),
        );
        if (missingCapability) {
          return [];
        }

        return [
          {
            addonId: manifest.id,
            surfaceId: surface.id,
            sectionId: navigation.sectionId,
            label: surface.label || manifest.name,
            eyebrow: navigation.eyebrow,
            dockIcon: navigation.dockIcon,
            order: navigation.order ?? 1000,
          },
        ];
      });
    })
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
