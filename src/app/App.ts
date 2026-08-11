import { html } from './html';
import { type Route, useRoute } from './router';
import { CompaniesView } from './views/CompaniesView';
import { JobDetailView } from './views/JobDetailView';
import { JobFormView } from './views/JobFormView';
import { JobsListView } from './views/JobsListView';

export function App() {
  const route = useRoute();
  const onJobsSection = route.name !== 'companies';

  return html`
    <div class="app-shell">
      <header class="app-header">
        <h1>Job Tracker</h1>
        <nav class="app-nav">
          <a href="#/jobs" class=${onJobsSection ? 'active' : ''}>Jobs</a>
          <a
            href="#/companies"
            class=${route.name === 'companies' ? 'active' : ''}
            >Companies</a
          >
          <a href="#/jobs/new" class="button-link">+ Add job</a>
        </nav>
      </header>
      <main class="app-main">${renderRoute(route)}</main>
    </div>
  `;
}

function renderRoute(route: Route) {
  if (route.name === 'jobs') {
    return html`<${JobsListView} initialQuery=${route.query} />`;
  }
  if (route.name === 'job-new') {
    return html`<${JobFormView} mode="new" />`;
  }
  if (route.name === 'job-edit') {
    return html`<${JobFormView} mode="edit" id=${route.id} />`;
  }
  if (route.name === 'job-detail') {
    return html`<${JobDetailView} id=${route.id} />`;
  }
  return html`<${CompaniesView} />`;
}
