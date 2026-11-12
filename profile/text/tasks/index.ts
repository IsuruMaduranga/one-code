/**
 * One Code's task-tool words (the profile's `text.tasks`): Claude Code's
 * TaskCreate/TaskGet/TaskList/TaskUpdate descriptions and parameter words
 * (descriptions.ts). The results and the periodic reminder are the base's.
 */

import type { TasksText } from "../../../extensions/sdk/profile.ts";
import {
	TASK_CREATE_DESCRIPTION,
	TASK_CREATE_PARAMS,
	TASK_GET_DESCRIPTION,
	TASK_GET_PARAMS,
	TASK_LIST_DESCRIPTION,
	TASK_UPDATE_DESCRIPTION,
	TASK_UPDATE_PARAMS,
} from "./descriptions.ts";

export const tasks: TasksText = {
	descriptions: {
		task_create: TASK_CREATE_DESCRIPTION,
		task_get: TASK_GET_DESCRIPTION,
		task_list: TASK_LIST_DESCRIPTION,
		task_update: TASK_UPDATE_DESCRIPTION,
	},
	params: { create: TASK_CREATE_PARAMS, get: TASK_GET_PARAMS, update: TASK_UPDATE_PARAMS },
	searchKeywords: ["task", "todo", "plan", "progress", "dependencies", "tracking"],
};
