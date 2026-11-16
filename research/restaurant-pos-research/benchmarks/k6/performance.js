import { constantVus, systemTags, traffic, vus, workload } from './common.js';

export const options = {
  systemTags,
  scenarios: { traffic: constantVus(vus, 'runTraffic') },
};

export function runTraffic() {
  traffic(workload === 'read' || workload === 'cold');
}
