import { ResourceState } from '../api/types';

const states: Record<string, ResourceState> = {};

export function getResourceState() {
    return states;
}
